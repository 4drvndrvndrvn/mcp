import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sseData } from '../src/nanogpt.js';
import { childEnv, expandEnv, normalizeServerConfig, sanitizeName, toolResultToText } from '../src/mcp.js';
import { evaluate } from '../examples/calc.js';

const streamOf = (...parts) =>
  new ReadableStream({
    start(controller) {
      for (const p of parts) controller.enqueue(new TextEncoder().encode(p));
      controller.close();
    },
  });

test('sseData handles events split across chunks and CRLF', async () => {
  const out = [];
  for await (const d of sseData(streamOf('data: {"a"', ':1}\r\n\r\n: comment\n\ndata: [DO', 'NE]\n\n'))) out.push(d);
  assert.deepEqual(out, ['{"a":1}', '[DONE]']);
});

test('sseData flushes a final event without a trailing blank line', async () => {
  const out = [];
  for await (const d of sseData(streamOf('data: x\n\ndata: y'))) out.push(d);
  assert.deepEqual(out, ['x', 'y']);
});

test('normalizeServerConfig infers type and validates', () => {
  assert.deepEqual(normalizeServerConfig({ command: 'npx', args: ['-y', 'pkg'] }), { type: 'stdio', command: 'npx', args: ['-y', 'pkg'] });
  assert.deepEqual(normalizeServerConfig({ url: 'https://x.dev/mcp' }), { type: 'http', url: 'https://x.dev/mcp' });
  assert.throws(() => normalizeServerConfig({ type: 'stdio' }), /command/);
  assert.throws(() => normalizeServerConfig({ url: 'not a url' }), /Invalid url/);
  assert.throws(() => normalizeServerConfig({ type: 'ws', url: 'https://x' }), /Unknown server type/);
});

test('expandEnv substitutes ${VAR}', () => {
  process.env.TEST_MCP_TOKEN = 'abc';
  assert.equal(expandEnv('Bearer ${TEST_MCP_TOKEN}'), 'Bearer abc');
  assert.equal(expandEnv('${DEFINITELY_NOT_SET_123}'), '');
});

test('sanitizeName produces valid function names', () => {
  assert.equal(sanitizeName('my server.v2'), 'my_server_v2');
  assert.match(sanitizeName('get-time'), /^[A-Za-z0-9_-]+$/);
});

test('toolResultToText flattens MCP content', () => {
  assert.equal(
    toolResultToText({ content: [{ type: 'text', text: 'a' }, { type: 'image', mimeType: 'image/png', data: '' }] }),
    'a\n\n[image: image/png]',
  );
  assert.equal(toolResultToText({ content: [], structuredContent: { x: 1 } }), '{\n  "x": 1\n}');
  assert.match(toolResultToText({ content: [{ type: 'text', text: 'z'.repeat(60_000) }] }), /\[truncated 10000 characters\]$/);
});

test('calculator evaluates safely', () => {
  assert.equal(evaluate('(17*23)^2'), 152881);
  assert.equal(evaluate('2^3^2'), 512);
  assert.equal(evaluate('-2^2'), -4);
  assert.equal(evaluate('max(1, sqrt(16), 3)'), 4);
  assert.throws(() => evaluate('process.exit()'));
  assert.throws(() => evaluate('1 +'));
});

test('childEnv passes network settings through but not secrets', () => {
  const parent = { HTTPS_PROXY: 'http://proxy:8080', NODE_EXTRA_CA_CERTS: '/ca.pem', NANOGPT_API_KEY: 'secret', HOME: '/h' };
  process.env.TEST_CHILD_TOKEN = 'tok';
  const env = childEnv({ TOKEN: '${TEST_CHILD_TOKEN}', HTTPS_PROXY: 'http://other:1' }, parent);
  assert.deepEqual(env, { HTTPS_PROXY: 'http://other:1', NODE_EXTRA_CA_CERTS: '/ca.pem', TOKEN: 'tok' });
});
