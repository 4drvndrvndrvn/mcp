import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpManager } from '../src/mcp.js';
import { mcpEndpoint } from '../src/mcp-endpoint.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const demo = { command: process.execPath, args: [path.join(ROOT, 'examples/demo-server.js')] };
let mcp;
let http;
let url;

before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-endpoint-'));
  mcp = new McpManager(path.join(dir, 'mcp-servers.json'));
  await mcp.addServer('demo', demo);
  await mcp.addServer('demo2', demo);
  await mcp.addServer('progress', { command: process.execPath, args: [path.join(ROOT, 'test/helpers/progress-server.js')] });
  const app = express();
  app.use(express.json());
  const config = { apiKey: '', exposeServers: null, defaultModel: 'm', maxToolRounds: 5 };
  app.post('/mcp', mcpEndpoint({ nano: null, mcp, config }));
  app.post('/mcp-demo', mcpEndpoint({ nano: null, mcp, config: { ...config, exposeServers: ['demo'] } }));
  http = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => http.once('listening', resolve));
  url = `http://127.0.0.1:${http.address().port}`;
});

after(async () => {
  await mcp.closeAll();
  http.close();
});

async function connect(pathname) {
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(pathname, url)));
  return client;
}

test('/mcp offers the configured servers\' tools, with instructions', async () => {
  const client = await connect('/mcp');
  try {
    assert.match(client.getInstructions(), /vast_screenshot/);
    const names = (await client.listTools()).tools.map((t) => t.name);
    // Two servers with the same tools: both get prefixed. No NanoGPT key: no chat tool.
    assert.ok(names.includes('demo__calculate') && names.includes('demo2__calculate'), names.join());
    assert.ok(!names.includes('chat'));
  } finally {
    await client.close();
  }
});

test('/mcp passes progress through', async () => {
  const client = await connect('/mcp');
  try {
    const progress = [];
    const r = await client.callTool({ name: 'count', arguments: {} }, undefined, { onprogress: (p) => progress.push(p.message) });
    assert.equal(r.content[0].text, 'counted');
    assert.deepEqual(progress, ['step 1', 'step 2', 'step 3']);
  } finally {
    await client.close();
  }
});

test('/mcp calls tools of the exposed servers only', async () => {
  const client = await connect('/mcp-demo');
  try {
    const tools = (await client.listTools()).tools;
    assert.deepEqual(tools.map((t) => t.name).sort(), ['calculate', 'get_current_time', 'random_number', 'wait']);
    assert.equal(tools.find((t) => t.name === 'get_current_time').annotations?.readOnlyHint, true);

    const r = await client.callTool({ name: 'calculate', arguments: { expression: '2 + 2' } });
    assert.match(r.content[0].text, /4/);


    const unknown = await client.callTool({ name: 'nope', arguments: {} });
    assert.equal(unknown.isError, true);
  } finally {
    await client.close();
  }
});
