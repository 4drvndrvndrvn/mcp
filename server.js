import path from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import express from 'express';
import { config, isLoopbackHost, ROOT_DIR } from './src/config.js';
import { NanoGPT } from './src/nanogpt.js';
import { McpManager } from './src/mcp.js';
import { runAgent } from './src/agent.js';
import { mcpEndpoint } from './src/mcp-endpoint.js';

if (!config.apiKey) {
  console.error('NANOGPT_API_KEY is not set. Copy .env.example to .env and add your key.');
  process.exit(1);
}

const nano = new NanoGPT({ apiKey: config.apiKey, baseUrl: config.baseUrl });
const mcp = new McpManager(config.mcpConfigPath);
const loopback = isLoopbackHost(config.host);
// Adding stdio servers runs commands on this machine, so only allow it from the
// UI when the server is local-only or protected by an access token.
const uiStdioAllowed = loopback || Boolean(config.accessToken);

const app = express();
app.disable('x-powered-by');

// Reject DNS-rebinding attempts against a localhost-only server.
if (loopback) {
  const allowed = new Set(['localhost', '127.0.0.1', '[::1]']);
  app.use((req, res, next) => {
    const host = (req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
    if (!allowed.has(host)) return res.status(403).json({ error: 'Forbidden host' });
    next();
  });
}

function tokenMatches(given) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(config.accessToken);
  return a.length === b.length && timingSafeEqual(a, b);
}

function requireAuth(req, res, next) {
  if (!config.accessToken) return next();
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : req.headers['x-access-token'];
  if (tokenMatches(token)) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

app.use(express.json({ limit: '20mb' }));

// ---- Public ----------------------------------------------------------------

app.get('/api/config', (req, res) => {
  res.json({
    defaultModel: config.defaultModel,
    authRequired: Boolean(config.accessToken),
    uiStdioAllowed,
    maxToolRounds: config.maxToolRounds,
  });
});

app.use(express.static(path.join(ROOT_DIR, 'public')));
app.get('/vendor/marked.js', (req, res) => res.sendFile(path.join(ROOT_DIR, 'node_modules/marked/lib/marked.umd.js')));
app.get('/vendor/purify.js', (req, res) => res.sendFile(path.join(ROOT_DIR, 'node_modules/dompurify/dist/purify.min.js')));

// ---- Authenticated API -----------------------------------------------------

app.use('/api', requireAuth);

app.get('/api/models', async (req, res) => {
  res.json({ models: await nano.listModels({ force: req.query.refresh === '1' }) });
});

app.get('/api/mcp/servers', (req, res) => res.json({ servers: mcp.list() }));

app.post('/api/mcp/servers', async (req, res) => {
  const { name, config: serverConfig } = req.body || {};
  const type = serverConfig?.type || (serverConfig?.url ? 'http' : 'stdio');
  if (type === 'stdio' && !uiStdioAllowed) {
    return res.status(403).json({
      error: 'Adding stdio servers from the web UI is disabled when HOST is public and ACCESS_TOKEN is not set. Edit mcp-servers.json instead.',
    });
  }
  try {
    await mcp.addServer(name, serverConfig);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  res.json({ servers: mcp.list() });
});

app.delete('/api/mcp/servers/:name', async (req, res) => {
  await mcp.removeServer(req.params.name);
  res.json({ servers: mcp.list() });
});

app.patch('/api/mcp/servers/:name', async (req, res) => {
  await mcp.setDisabled(req.params.name, Boolean(req.body?.disabled));
  res.json({ servers: mcp.list() });
});

app.post('/api/mcp/servers/:name/reconnect', async (req, res) => {
  await mcp.connect(req.params.name);
  res.json({ servers: mcp.list() });
});

// Tool calls waiting for the user to approve or deny them, keyed by `${runId}:${callId}`.
const pendingApprovals = new Map();

app.post('/api/chat/approve', (req, res) => {
  const { runId, id, approved } = req.body || {};
  const pending = pendingApprovals.get(`${runId}:${id}`);
  if (!pending) return res.status(404).json({ error: 'No tool call is waiting for approval with that id' });
  pending(Boolean(approved));
  res.json({ ok: true });
});

app.post('/api/chat', async (req, res) => {
  const { model, messages, system, temperature, useTools = true, servers, confirmTools = true } = req.body || {};
  if (!model || !Array.isArray(messages)) {
    return res.status(400).json({ error: '"model" and "messages" are required' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (event) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  const heartbeat = setInterval(() => !res.writableEnded && res.write(': ping\n\n'), 15_000);
  const abort = new AbortController();
  res.on('close', () => abort.abort());

  const runId = randomUUID();
  send({ type: 'run', runId });
  const approve = (call) =>
    new Promise((resolve) => {
      const key = `${runId}:${call.id}`;
      const finish = (approved) => {
        pendingApprovals.delete(key);
        abort.signal.removeEventListener('abort', onAbort);
        resolve(approved);
      };
      const onAbort = () => finish(false);
      if (abort.signal.aborted) return resolve(false);
      pendingApprovals.set(key, finish);
      abort.signal.addEventListener('abort', onAbort, { once: true });
    });

  try {
    const added = await runAgent({
      nano,
      mcp,
      model,
      messages,
      system: typeof system === 'string' && system.trim() ? system : undefined,
      temperature: typeof temperature === 'number' ? temperature : undefined,
      useTools: Boolean(useTools),
      servers: Array.isArray(servers) ? servers : undefined,
      approve: confirmTools === false ? undefined : approve,
      maxRounds: config.maxToolRounds,
      signal: abort.signal,
      emit: send,
    });
    send({ type: 'done', messages: added });
  } catch (err) {
    if (!abort.signal.aborted) {
      console.error('[chat]', err.message);
      send({ type: 'error', message: err.message });
    }
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
});

// ---- MCP server endpoint ---------------------------------------------------

app.post('/mcp', requireAuth, mcpEndpoint({ nano, mcp, config }));
app.all('/mcp', requireAuth, (req, res) => {
  res.status(405).set('Allow', 'POST').json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed (stateless server: use POST)' },
    id: null,
  });
});

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

// ---- Start -----------------------------------------------------------------

await mcp.init().catch((err) => console.error(`[mcp] ${err.message}`));

const server = app.listen(config.port, config.host, () => {
  const shownHost = config.host.includes(':') ? `[${config.host}]` : config.host;
  console.log(`NanoGPT MCP chat running at http://${shownHost}:${config.port}`);
  console.log(`MCP endpoint: http://${shownHost}:${config.port}/mcp`);
  if (!loopback && !config.accessToken) {
    console.warn('WARNING: listening on a public interface without ACCESS_TOKEN. Anyone who can reach this port can use your NanoGPT credits.');
  }
});

async function shutdown() {
  console.log('Shutting down...');
  server.close();
  await mcp.closeAll();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
