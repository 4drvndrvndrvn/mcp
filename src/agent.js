// Runs a conversation turn: streams the model's reply and, whenever it asks for
// tools, executes them on the MCP servers and feeds the results back in.

import { toolResultToText } from './mcp.js';

const ROLES = new Set(['system', 'user', 'assistant', 'tool']);

/** Keeps only the fields the chat completions API understands. */
export function sanitizeMessages(messages) {
  if (!Array.isArray(messages)) throw new Error('"messages" must be an array');
  return messages
    .filter((m) => m && ROLES.has(m.role))
    .map((m) => {
      const out = { role: m.role, content: m.content ?? null };
      if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
        out.tool_calls = m.tool_calls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.function?.name, arguments: tc.function?.arguments ?? '{}' },
        }));
      }
      if (m.role === 'tool') out.tool_call_id = m.tool_call_id;
      if (out.content === null && m.role !== 'assistant') out.content = '';
      return out;
    });
}

/**
 * @param {object} opts
 * @param {import('./nanogpt.js').NanoGPT} opts.nano
 * @param {import('./mcp.js').McpManager} opts.mcp
 * @param {(event: object) => void} opts.emit  receives streaming events for the UI
 * @returns {Promise<object[]>} the messages added during this turn
 */
export async function runAgent({
  nano,
  mcp,
  model,
  messages,
  system,
  temperature,
  useTools = true,
  servers,
  maxRounds = 10,
  signal,
  emit = () => {},
}) {
  const history = sanitizeMessages(messages);
  const added = [];
  const usage = { cost: null, inputTokens: 0, outputTokens: 0 };

  let tools = [];
  let lookup = new Map();
  if (useTools) {
    ({ tools, lookup } = mcp.getOpenAITools(servers));
    if (tools.length) {
      const info = await nano.getModel(model);
      if (info && info.toolCalling === false) {
        emit({ type: 'notice', message: `${model} does not support tool calling, so MCP tools are disabled for this reply.` });
        tools = [];
      }
    }
  }

  const prefix = system ? [{ role: 'system', content: system }] : [];

  for (let round = 1; ; round++) {
    // After maxRounds rounds of tool use, forbid more calls so the model answers in text.
    const allowTools = tools.length > 0 && round <= maxRounds;
    if (tools.length && !allowTools) {
      emit({ type: 'notice', message: `Reached the limit of ${maxRounds} tool rounds; asking the model to answer now.` });
    }

    let content = '';
    let reasoning = '';
    const calls = [];
    let finishReason = null;
    let roundCost = null;
    let roundTokens = null;

    const stream = nano.streamChat({
      model,
      messages: [...prefix, ...history, ...sanitizeMessages(added)],
      tools,
      toolChoice: allowTools ? undefined : 'none',
      temperature,
      signal,
    });

    for await (const chunk of stream) {
      // NanoGPT reports cost in `x_nanogpt_pricing`; token counts may come from either field.
      const pricing = chunk.x_nanogpt_pricing;
      if (pricing) {
        roundCost = Number(pricing.cost ?? pricing.amount ?? 0);
        if (pricing.inputTokens || pricing.outputTokens) {
          roundTokens = { input: Number(pricing.inputTokens || 0), output: Number(pricing.outputTokens || 0) };
        }
      }
      if (chunk.usage && !roundTokens) {
        roundTokens = { input: Number(chunk.usage.prompt_tokens || 0), output: Number(chunk.usage.completion_tokens || 0) };
      }
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta || {};
      const think = delta.reasoning ?? delta.reasoning_content;
      if (typeof think === 'string' && think) {
        reasoning += think;
        emit({ type: 'reasoning', content: think });
      }
      if (typeof delta.content === 'string' && delta.content) {
        content += delta.content;
        emit({ type: 'delta', content: delta.content });
      }
      for (const tc of delta.tool_calls || []) {
        const i = tc.index ?? calls.length;
        calls[i] ||= { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (tc.id) calls[i].id = tc.id;
        if (tc.function?.name) calls[i].function.name += tc.function.name;
        if (tc.function?.arguments) calls[i].function.arguments += tc.function.arguments;
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }

    if (roundCost != null) usage.cost = (usage.cost || 0) + roundCost;
    if (roundTokens) {
      usage.inputTokens += roundTokens.input;
      usage.outputTokens += roundTokens.output;
    }

    const toolCalls = calls.filter(Boolean).map((tc, i) => ({
      ...tc,
      id: tc.id || `call_${Date.now().toString(36)}_${i}`,
      function: { ...tc.function, arguments: tc.function.arguments || '{}' },
    }));

    const assistant = { role: 'assistant', content: content || null };
    if (toolCalls.length) assistant.tool_calls = toolCalls;
    if (reasoning) assistant.reasoning = reasoning;
    added.push(assistant);
    emit({ type: 'assistant_end', finishReason });

    if (!toolCalls.length || !allowTools) break;

    for (const call of toolCalls) {
      const target = lookup.get(call.function.name);
      emit({
        type: 'tool_call',
        id: call.id,
        name: call.function.name,
        server: target?.server,
        tool: target?.tool,
        arguments: call.function.arguments,
      });

      let text;
      let isError = false;
      try {
        if (!target) throw new Error(`Unknown tool "${call.function.name}"`);
        let args;
        try {
          args = JSON.parse(call.function.arguments || '{}');
        } catch {
          throw new Error(`Tool arguments are not valid JSON: ${call.function.arguments}`);
        }
        const result = await mcp.callTool(target.server, target.tool, args, { signal });
        text = toolResultToText(result);
        isError = Boolean(result.isError);
      } catch (err) {
        if (signal?.aborted) throw err;
        text = `Error: ${err.message}`;
        isError = true;
      }

      // `isError` is for the UI only; sanitizeMessages drops it before the next API call.
      added.push({ role: 'tool', tool_call_id: call.id, content: text || '(no output)', isError });
      emit({ type: 'tool_result', id: call.id, content: text, isError });
    }
  }

  emit({ type: 'usage', ...usage });
  return added;
}
