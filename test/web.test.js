import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('web_search asks an :online model and returns its answer with the cost', async () => {
  const requests = [];
  const api = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    requests.push({ path: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'TuxBlox runs Roblox on Linux. Install: curl -sSLf https://tuxblox.net/install.sh | bash' } }],
      x_nanogpt_pricing: { cost: 0.0514 },
    }));
  });
  await new Promise((r) => api.listen(0, '127.0.0.1', r));
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve(import.meta.dirname, '../servers/web.js')],
    env: { NANOGPT_API_KEY: 'k', NANOGPT_BASE_URL: `http://127.0.0.1:${api.address().port}` },
  }));
  try {
    const { tools } = await client.listTools();
    assert.equal(tools[0].annotations.readOnlyHint, true);
    const r = await client.callTool({ name: 'web_search', arguments: { query: 'what is tuxblox' } });
    assert.match(r.content[0].text, /tuxblox\.net\/install\.sh/);
    assert.match(r.content[0].text, /search cost: \$0\.0514/);
    assert.equal(requests[0].path, '/chat/completions');
    assert.equal(requests[0].auth, 'Bearer k');
    assert.equal(requests[0].body.model, 'openai/gpt-5.4-mini:online');
    assert.equal(requests[0].body.messages.at(-1).content, 'what is tuxblox');
  } finally {
    await client.close();
    api.close();
  }
});
