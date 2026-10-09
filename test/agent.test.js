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

test('stops offering tools after maxRounds', async () => {
  const call = (id) => [delta({ tool_calls: [{ index: 0, id, function: { name: 'demo__calculate', arguments: '{"expression":"1"}' } }] }, 'tool_calls')];
  const nano = fakeNano([call('a'), call('b'), [delta({ content: 'done' }, 'stop')]]);
  const events = [];
  const added = await runAgent({ nano, mcp: fakeMcp(), model: 'm', messages: [{ role: 'user', content: 'x' }], maxRounds: 2, emit: (e) => events.push(e) });
  assert.equal(nano.requests.length, 3);
  assert.equal(nano.requests[2].toolChoice, 'none');
  assert.equal(added.at(-1).content, 'done');
  assert.ok(events.some((e) => e.type === 'notice'));
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
