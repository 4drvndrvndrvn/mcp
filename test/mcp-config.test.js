import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpManager } from '../src/mcp.js';

const example = JSON.parse(fs.readFileSync(new URL('../mcp-servers.example.json', import.meta.url), 'utf8')).mcpServers;

async function init(fileContent) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-config-'));
  const file = path.join(dir, 'mcp-servers.json');
  if (fileContent) fs.writeFileSync(file, JSON.stringify(fileContent));
  const mgr = new McpManager(file);
  mgr.connect = async () => {}; // don't start real servers
  await mgr.init();
  return { mgr, saved: JSON.parse(fs.readFileSync(file, 'utf8')) };
}

test('a new config gets every bundled server', async () => {
  const { saved } = await init(null);
  assert.deepEqual(Object.keys(saved.mcpServers).sort(), Object.keys(example).sort());
  assert.deepEqual(saved.bundled.sort(), Object.keys(example).sort());
});

test('an old config (demo only, no "bundled") gains the new bundled servers', async () => {
  const { saved } = await init({ mcpServers: { demo: example.demo, mine: { url: 'https://x.dev/mcp' } } });
  assert.ok(saved.mcpServers.vast);
  assert.ok(saved.mcpServers.ssh);
  assert.ok(saved.mcpServers.mine);
});

test('a bundled server the user removed stays removed', async () => {
  const { saved } = await init({ mcpServers: { demo: example.demo }, bundled: Object.keys(example) });
  assert.deepEqual(Object.keys(saved.mcpServers), ['demo']);
});
