import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAgent, sanitizeMessages } from '../src/agent.js';

/** Fake NanoGPT client that replays scripted streaming rounds. */
function fakeNano(rounds, { toolCalling = true } = {}) {
  const requests = [];
  return {
    requests,
    async getModel() {
      return { id: 'm', toolCalling };
    },
    async *streamChat(req) {
      requests.push(structuredClone({ ...req, signal: undefined }));
      const chunks = rounds[requests.length - 1];
      if (!chunks) throw new Error('unexpected extra round');
      yield* chunks;
    },
  };
}

function fakeMcp(results = {}) {
  const calls = [];
  return {
    calls,
    getOpenAITools() {
      return {
        tools: [{ type: 'function', function: { name: 'demo__calculate', parameters: { type: 'object', properties: {} } } }],
        lookup: new Map([['demo__calculate', { server: 'demo', tool: 'calculate' }]]),
      };
    },
    async callTool(server, tool, args) {
      calls.push({ server, tool, args });
      return results[tool] || { content: [{ type: 'text', text: `${args.expression} = 4` }] };
    },
  };
}

const delta = (d, finish = null) => ({ choices: [{ index: 0, delta: d, finish_reason: finish }] });

test('streams a plain text reply', async () => {
  const nano = fakeNano([[delta({ content: 'Hel' }), delta({ content: 'lo' }, 'stop')]]);
  const events = [];
  const added = await runAgent({ nano, mcp: fakeMcp(), model: 'm', messages: [{ role: 'user', content: 'hi' }], emit: (e) => events.push(e) });
  assert.deepEqual(added, [{ role: 'assistant', content: 'Hello' }]);
  assert.deepEqual(events.filter((e) => e.type === 'delta').map((e) => e.content), ['Hel', 'lo']);
});

test('executes streamed tool calls and feeds results back', async () => {
  const nano = fakeNano([
    [
      delta({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'demo__calculate', arguments: '{"expr' } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: 'ession":"2+2"}' } }] }, 'tool_calls'),
    ],
    [delta({ content: 'It is 4.' }, 'stop')],
  ]);
  const mcp = fakeMcp();
  const added = await runAgent({ nano, mcp, model: 'm', messages: [{ role: 'user', content: '2+2?' }] });

  assert.deepEqual(mcp.calls, [{ server: 'demo', tool: 'calculate', args: { expression: '2+2' } }]);
  assert.equal(added.length, 3);
  assert.equal(added[0].tool_calls[0].function.arguments, '{"expression":"2+2"}');
  assert.deepEqual(added[1], { role: 'tool', tool_call_id: 'c1', content: '2+2 = 4', isError: false });
  assert.equal(added[2].content, 'It is 4.');
  // The second request includes the tool round trip.
  const second = nano.requests[1].messages;
  assert.equal(second.at(-1).role, 'tool');
  assert.equal(second.at(-1).isError, undefined);
});

test('reports bad tool arguments to the model instead of crashing', async () => {
  const nano = fakeNano([
    [delta({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'demo__calculate', arguments: '{nope' } }] }, 'tool_calls')],
    [delta({ content: 'Sorry.' }, 'stop')],
  ]);
  const added = await runAgent({ nano, mcp: fakeMcp(), model: 'm', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(added[1].isError, true);
  assert.match(added[1].content, /not valid JSON/);
});

test('after maxRounds the model gets wrap-up rounds, then tools are switched off', async () => {
  const call = (id) => [delta({ tool_calls: [{ index: 0, id, function: { name: 'demo__calculate', arguments: '{"expression":"1"}' } }] }, 'tool_calls')];
  const nano = fakeNano([call('a'), call('b'), call('c'), call('d'), call('e'), [delta({ content: 'done' }, 'stop')]]);
  const events = [];
  const added = await runAgent({ nano, mcp: fakeMcp(), model: 'm', messages: [{ role: 'user', content: 'x' }], maxRounds: 2, emit: (e) => events.push(e) });
  assert.equal(nano.requests.length, 6);
  // Rounds 3-5 still allow tools but tell the model to clean up.
  for (const r of nano.requests.slice(2, 5)) {
    assert.equal(r.toolChoice, undefined);
    assert.match(r.messages.at(-1).content, /tool-call budget/);
  }
  assert.doesNotMatch(String(nano.requests[1].messages.at(-1).content), /tool-call budget/);
  assert.equal(nano.requests[5].toolChoice, 'none');
  assert.equal(added.at(-1).content, 'done');
  assert.equal(added.filter((m) => m.role === 'user').length, 0, 'the notice is not saved in history');
  assert.equal(events.filter((e) => e.type === 'notice').length, 1);
});

test('the model can clean up during wrap-up and then finish', async () => {
  const call = (id) => [delta({ tool_calls: [{ index: 0, id, function: { name: 'demo__calculate', arguments: '{"expression":"1"}' } }] }, 'tool_calls')];
  const nano = fakeNano([call('a'), call('cleanup'), [delta({ content: 'cleaned up' }, 'stop')]]);
  const mcp = fakeMcp();
  const added = await runAgent({ nano, mcp, model: 'm', messages: [{ role: 'user', content: 'x' }], maxRounds: 1 });
  assert.equal(mcp.calls.length, 2);
  assert.equal(added.at(-1).content, 'cleaned up');
});

test('skips tools for models without tool calling', async () => {
  const nano = fakeNano([[delta({ content: 'ok' }, 'stop')]], { toolCalling: false });
  await runAgent({ nano, mcp: fakeMcp(), model: 'm', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(nano.requests[0].tools.length, 0);
});

test('sanitizeMessages drops UI-only fields', () => {
  const out = sanitizeMessages([
    { role: 'user', content: 'hi', meta: { cost: 1 } },
    { role: 'assistant', content: null, reasoning: 'hmm', tool_calls: [{ id: 'c', function: { name: 'f', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c', content: 'r', isError: true },
    { role: 'bogus', content: 'x' },
  ]);
  assert.deepEqual(out, [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'f', arguments: '{}' } }] },
    { role: 'tool', content: 'r', tool_call_id: 'c' },
  ]);
});

function readOnlyAwareMcp() {
  const calls = [];
  return {
    calls,
    getOpenAITools(_servers, { readOnlyOnly = false } = {}) {
      const all = [
        { name: 'vast__vast_destroy_instance', server: 'vast', tool: 'vast_destroy_instance', readOnly: false },
        { name: 'vast__vast_get_instance', server: 'vast', tool: 'vast_get_instance', readOnly: true },
      ].filter((t) => !readOnlyOnly || t.readOnly);
      return {
        tools: all.map((t) => ({ type: 'function', function: { name: t.name, parameters: { type: 'object', properties: {} } } })),
        lookup: new Map(all.map((t) => [t.name, t])),
      };
    },
    async callTool(server, tool, args, { onProgress } = {}) {
      calls.push(tool);
      onProgress?.({ progress: 1, message: 'working' });
      return { content: [{ type: 'text', text: `${tool} ok` }] };
    },
  };
}

const callTool = (id, name) => [delta({ tool_calls: [{ index: 0, id, function: { name, arguments: '{"instance_id":1}' } }] }, 'tool_calls')];

test('asks for approval before tools that are not read-only', async () => {
  const nano = fakeNano([callTool('d1', 'vast__vast_destroy_instance'), [delta({ content: 'ok' }, 'stop')]]);
  const mcp = readOnlyAwareMcp();
  const asked = [];
  const events = [];
  const added = await runAgent({
    nano, mcp, model: 'm', messages: [{ role: 'user', content: 'x' }],
    approve: async (call) => (asked.push(call), true),
    emit: (e) => events.push(e),
  });
  assert.deepEqual(asked.map((c) => [c.tool, c.args]), [['vast_destroy_instance', { instance_id: 1 }]]);
  assert.deepEqual(mcp.calls, ['vast_destroy_instance']);
  assert.equal(events.find((e) => e.type === 'tool_call').needsApproval, true);
  assert.deepEqual(events.find((e) => e.type === 'tool_progress'), { type: 'tool_progress', id: 'd1', message: 'working', progress: 1, total: undefined });
  assert.equal(added[1].content, 'vast_destroy_instance ok');
});

test('a denied tool call is not run and the model is told', async () => {
  const nano = fakeNano([callTool('d1', 'vast__vast_destroy_instance'), [delta({ content: 'ok' }, 'stop')]]);
  const mcp = readOnlyAwareMcp();
  const added = await runAgent({ nano, mcp, model: 'm', messages: [{ role: 'user', content: 'x' }], approve: async () => false });
  assert.deepEqual(mcp.calls, []);
  assert.equal(added[1].isError, true);
  assert.match(added[1].content, /declined/);
});

test('read-only tools run without approval', async () => {
  const nano = fakeNano([callTool('g1', 'vast__vast_get_instance'), [delta({ content: 'ok' }, 'stop')]]);
  const mcp = readOnlyAwareMcp();
  let asked = false;
  await runAgent({ nano, mcp, model: 'm', messages: [{ role: 'user', content: 'x' }], approve: async () => (asked = true) });
  assert.equal(asked, false);
  assert.deepEqual(mcp.calls, ['vast_get_instance']);
});

test('readOnlyTools only offers read-only tools (used by /mcp)', async () => {
  const nano = fakeNano([[delta({ content: 'ok' }, 'stop')]]);
  await runAgent({ nano, mcp: readOnlyAwareMcp(), model: 'm', messages: [{ role: 'user', content: 'x' }], readOnlyTools: true });
  assert.deepEqual(nano.requests[0].tools.map((t) => t.function.name), ['vast__vast_get_instance']);
});
