import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

try {
  process.loadEnvFile(path.join(ROOT_DIR, '.env'));
} catch {
  // No .env file: rely on the real environment.
}

const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const list = (value) => String(value || '').split(',').map((s) => s.trim()).filter(Boolean);

function exposeList(value) {
  const names = list(value);
  if (!names.length || names.includes('*') || names.includes('all')) return null;
  return names.includes('none') ? [] : names;
}

export const config = {
  apiKey: process.env.NANOGPT_API_KEY || '',
  baseUrl: (process.env.NANOGPT_BASE_URL || 'https://nano-gpt.com/api/v1').replace(/\/+$/, ''),
  defaultModel: process.env.DEFAULT_MODEL || 'openai/gpt-5.4-mini',
  host: process.env.HOST || '127.0.0.1',
  port: num(process.env.PORT, 3000),
  accessToken: process.env.ACCESS_TOKEN || '',
  mcpConfigPath: path.resolve(ROOT_DIR, process.env.MCP_CONFIG || 'mcp-servers.json'),
  maxToolRounds: num(process.env.MAX_TOOL_ROUNDS, 20),
  // Extra hostnames accepted while HOST is loopback, e.g. the domain a reverse proxy forwards.
  allowedHosts: list(process.env.ALLOWED_HOSTS).map((h) => h.toLowerCase()),
  // MCP servers whose tools /mcp offers; null means all of them.
  exposeServers: exposeList(process.env.EXPOSE_MCP_SERVERS),
};

export function isLoopbackHost(host) {
  return ['127.0.0.1', 'localhost', '::1'].includes(host);
}
