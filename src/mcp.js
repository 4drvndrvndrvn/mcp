// Connects to MCP servers (stdio, Streamable HTTP, or legacy SSE) and exposes
// their tools to the LLM as OpenAI-style function definitions.

import fs from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { ROOT_DIR } from './config.js';

const CLIENT_INFO = { name: 'nanogpt-mcp-chat', version: '1.0.0' };
const CONNECT_TIMEOUT_MS = 30_000;
// A tool call fails after 2 minutes without progress, or after 1 hour in total.
const TOOL_TIMEOUT_MS = 120_000;
const TOOL_MAX_TOTAL_MS = 60 * 60_000;
const MAX_TOOL_RESULT_CHARS = 50_000;
const SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,40}$/;

/** Replaces `${VAR}` with the value of the environment variable VAR. */
export function expandEnv(value) {
  if (typeof value !== 'string') return value;
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, key) => process.env[key] ?? '');
}

const expandRecord = (record) =>
  Object.fromEntries(Object.entries(record || {}).map(([k, v]) => [k, expandEnv(String(v))]));

/** Validates and normalizes one server entry from the config file or the UI. */
export function normalizeServerConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') throw new Error('Server config must be an object');
  const type = cfg.type || (cfg.url ? 'http' : 'stdio');
  const out = { type };
  if (cfg.disabled) out.disabled = true;
  if (type === 'stdio') {
    if (!cfg.command || typeof cfg.command !== 'string') throw new Error('stdio servers need a "command"');
    out.command = cfg.command;
    if (cfg.args != null) {
      if (!Array.isArray(cfg.args)) throw new Error('"args" must be an array of strings');
      out.args = cfg.args.map(String);
    }
    if (cfg.env) out.env = Object.fromEntries(Object.entries(cfg.env).map(([k, v]) => [k, String(v)]));
    if (cfg.cwd) out.cwd = String(cfg.cwd);
  } else if (type === 'http' || type === 'sse') {
    if (!cfg.url || typeof cfg.url !== 'string') throw new Error(`${type} servers need a "url"`);
    try {
      new URL(expandEnv(cfg.url));
    } catch {
      throw new Error(`Invalid url: ${cfg.url}`);
    }
    out.url = cfg.url;
    if (cfg.headers) {
      out.headers = Object.fromEntries(Object.entries(cfg.headers).map(([k, v]) => [k, String(v)]));
    }
  } else {
    throw new Error(`Unknown server type "${type}" (use stdio, http or sse)`);
  }
  return out;
}

/** Makes a name safe for OpenAI function names: ^[a-zA-Z0-9_-]{1,64}$ */
export function sanitizeName(name) {
  return String(name).replace(/[^A-Za-z0-9_-]/g, '_') || 'tool';
}

/** Flattens an MCP CallToolResult into text the LLM can read. */
export function toolResultToText(result) {
  if (!result) return '';
  if (result.toolResult !== undefined) {
    return typeof result.toolResult === 'string' ? result.toolResult : JSON.stringify(result.toolResult);
  }
  const parts = [];
  for (const item of result.content || []) {
    if (item.type === 'text') parts.push(item.text);
    else if (item.type === 'image') parts.push(`[image: ${item.mimeType}]`);
    else if (item.type === 'audio') parts.push(`[audio: ${item.mimeType}]`);
    else if (item.type === 'resource') {
      const r = item.resource || {};
      parts.push(r.text != null ? `[resource ${r.uri}]\n${r.text}` : `[resource ${r.uri} (${r.mimeType || 'binary'})]`);
    } else if (item.type === 'resource_link') parts.push(`[resource link: ${item.uri}]`);
    else parts.push(JSON.stringify(item));
  }
  if (!parts.length && result.structuredContent !== undefined) {
    parts.push(JSON.stringify(result.structuredContent, null, 2));
  }
  let text = parts.join('\n\n');
  if (text.length > MAX_TOOL_RESULT_CHARS) {
    text = `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n\n[truncated ${text.length - MAX_TOOL_RESULT_CHARS} characters]`;
  }
  return text;
}

function cleanSchema(schema) {
  const out = { ...(schema && typeof schema === 'object' ? schema : {}) };
  delete out.$schema;
  if (out.type !== 'object') out.type = 'object';
  if (!out.properties) out.properties = {};
  return out;
}

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export class McpManager {
  constructor(configPath) {
    this.configPath = configPath;
    /** @type {Map<string, {config: object, client?: Client, status: string, error?: string, tools: object[], stderr: string[]}>} */
    this.servers = new Map();
    this.bundled = [];
  }

  async _readConfigFile() {
    try {
      return JSON.parse(await fs.readFile(this.configPath, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw new Error(`Could not read ${this.configPath}: ${err.message}`);
    }
  }

  async _saveConfigFile(servers = Object.fromEntries([...this.servers].map(([name, e]) => [name, e.config]))) {
    const json = { mcpServers: servers, bundled: this.bundled };
    await fs.writeFile(this.configPath, `${JSON.stringify(json, null, 2)}\n`);
  }

  /**
   * Loads the config file and connects every enabled server. Servers shipped in
   * mcp-servers.example.json are added once; `bundled` remembers which were offered,
   * so a server the user removed doesn't come back.
   */
  async init() {
    const example = JSON.parse(await fs.readFile(`${ROOT_DIR}/mcp-servers.example.json`, 'utf8')).mcpServers || {};
    const file = await this._readConfigFile();
    const servers = { ...(file?.mcpServers || {}) };
    // Files from before `bundled` existed were created when only "demo" shipped.
    this.bundled = file ? (Array.isArray(file.bundled) ? [...file.bundled] : ['demo']) : [];
    const added = [];
    for (const [name, cfg] of Object.entries(example)) {
      if (this.bundled.includes(name)) continue;
      this.bundled.push(name);
      if (!servers[name]) {
        servers[name] = cfg;
        added.push(name);
      }
    }
    if (!file || added.length || !Array.isArray(file.bundled)) {
      await this._saveConfigFile(servers);
      if (added.length) console.log(`[mcp] added bundled servers to ${this.configPath}: ${added.join(', ')}`);
    }
    for (const [name, raw] of Object.entries(servers)) {
      try {
        this.servers.set(name, { config: normalizeServerConfig(raw), status: 'disconnected', tools: [], stderr: [] });
      } catch (err) {
        console.error(`[mcp] skipping "${name}": ${err.message}`);
      }
    }
    await Promise.all([...this.servers.keys()].map((name) => this.connect(name)));
  }

  async connect(name) {
    const entry = this.servers.get(name);
    if (!entry) throw new Error(`Unknown MCP server "${name}"`);
    await this._disconnect(entry);
    if (entry.config.disabled) {
      entry.status = 'disabled';
      return entry;
    }
    entry.status = 'connecting';
    entry.error = undefined;
    entry.stderr = [];
    try {
      const client = await withTimeout(
        this._open(name, entry),
        CONNECT_TIMEOUT_MS,
        `Timed out connecting after ${CONNECT_TIMEOUT_MS / 1000}s`,
      );
      entry.client = client;
      client.onclose = () => {
        if (entry.client === client) {
          entry.client = undefined;
          entry.status = 'error';
          entry.error = entry.error || 'Connection closed';
        }
      };
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
        this._refreshTools(entry).catch((err) => console.error(`[mcp] ${name}: ${err.message}`));
      });
      await this._refreshTools(entry);
      entry.status = 'connected';
      console.log(`[mcp] ${name}: connected (${entry.tools.length} tools)`);
    } catch (err) {
      const stderr = entry.stderr.join('').trim().split('\n').slice(-5).join('\n');
      entry.status = 'error';
      entry.error = stderr ? `${err.message}\n${stderr}` : err.message;
      console.error(`[mcp] ${name}: ${entry.error}`);
      await this._disconnect(entry, { keepStatus: true });
    }
    return entry;
  }

  async _open(name, entry) {
    const cfg = entry.config;
    if (cfg.type === 'stdio') {
      const transport = new StdioClientTransport({
        command: cfg.command,
        args: (cfg.args || []).map(expandEnv),
        // The SDK merges this with a safe default environment (PATH, HOME, ...),
        // so secrets like NANOGPT_API_KEY are only passed on when referenced as ${VAR}.
        env: expandRecord(cfg.env),
        cwd: cfg.cwd ? expandEnv(cfg.cwd) : ROOT_DIR,
        stderr: 'pipe',
      });
      transport.stderr?.on('data', (chunk) => {
        entry.stderr.push(chunk.toString());
        if (entry.stderr.length > 50) entry.stderr.shift();
      });
      const client = new Client(CLIENT_INFO);
      await client.connect(transport);
      return client;
    }

    const url = new URL(expandEnv(cfg.url));
    const requestInit = { headers: expandRecord(cfg.headers) };
    if (cfg.type === 'sse') {
      const client = new Client(CLIENT_INFO);
      await client.connect(new SSEClientTransport(url, { requestInit }));
      return client;
    }
    // Streamable HTTP, falling back to legacy SSE for older servers.
    try {
      const client = new Client(CLIENT_INFO);
      await client.connect(new StreamableHTTPClientTransport(url, { requestInit }));
      return client;
    } catch (err) {
      try {
        const client = new Client(CLIENT_INFO);
        await client.connect(new SSEClientTransport(url, { requestInit }));
        return client;
      } catch {
        throw err;
      }
    }
  }

  async _refreshTools(entry) {
    const tools = [];
    let cursor;
    do {
      const page = await entry.client.listTools(cursor ? { cursor } : undefined);
      tools.push(...(page.tools || []));
      cursor = page.nextCursor;
    } while (cursor);
    entry.tools = tools;
  }

  async _disconnect(entry, { keepStatus = false } = {}) {
    const client = entry.client;
    entry.client = undefined;
    entry.tools = keepStatus ? entry.tools : [];
    if (!keepStatus) entry.status = 'disconnected';
    if (client) await client.close().catch(() => {});
  }

  /** Adds (or replaces) a server, connects it, and saves the config file. */
  async addServer(name, rawConfig) {
    if (!SERVER_NAME_RE.test(name || '')) {
      throw new Error('Server name must be 1-40 characters: letters, numbers, "_" or "-"');
    }
    const cfg = normalizeServerConfig(rawConfig);
    const existing = this.servers.get(name);
    if (existing) await this._disconnect(existing);
    this.servers.set(name, { config: cfg, status: 'disconnected', tools: [], stderr: [] });
    await this._saveConfigFile();
    return this.connect(name);
  }

  async removeServer(name) {
    const entry = this.servers.get(name);
    if (!entry) throw new Error(`Unknown MCP server "${name}"`);
    await this._disconnect(entry);
    this.servers.delete(name);
    await this._saveConfigFile();
  }

  async setDisabled(name, disabled) {
    const entry = this.servers.get(name);
    if (!entry) throw new Error(`Unknown MCP server "${name}"`);
    if (disabled) entry.config.disabled = true;
    else delete entry.config.disabled;
    await this._saveConfigFile();
    return this.connect(name);
  }

  /** Public view of all servers (secrets in env/headers are not included). */
  list() {
    return [...this.servers].map(([name, e]) => ({
      name,
      type: e.config.type,
      target: e.config.type === 'stdio' ? [e.config.command, ...(e.config.args || [])].join(' ') : e.config.url,
      status: e.status,
      error: e.error || null,
      disabled: Boolean(e.config.disabled),
      tools: e.tools.map((t) => ({
        name: t.name,
        title: t.title || t.annotations?.title,
        description: t.description || '',
        readOnly: t.annotations?.readOnlyHint === true,
      })),
    }));
  }

  /**
   * Builds OpenAI `tools` for the given servers (all connected servers if omitted),
   * plus a lookup from function name back to {server, tool}.
   */
  getOpenAITools(serverNames, { readOnlyOnly = false } = {}) {
    const tools = [];
    const lookup = new Map();
    for (const [server, entry] of this.servers) {
      if (entry.status !== 'connected') continue;
      if (serverNames && !serverNames.includes(server)) continue;
      for (const tool of entry.tools) {
        const readOnly = tool.annotations?.readOnlyHint === true;
        if (readOnlyOnly && !readOnly) continue;
        let fnName = `${sanitizeName(server)}__${sanitizeName(tool.name)}`.slice(0, 64);
        for (let i = 2; lookup.has(fnName); i++) fnName = `${fnName.slice(0, 60)}_${i}`;
        lookup.set(fnName, { server, tool: tool.name, readOnly });
        tools.push({
          type: 'function',
          function: {
            name: fnName,
            description: `[${server}] ${tool.description || tool.title || tool.name}`.slice(0, 1024),
            parameters: cleanSchema(tool.inputSchema),
          },
        });
      }
    }
    return { tools, lookup };
  }

  async callTool(server, tool, args, { signal, onProgress } = {}) {
    const entry = this.servers.get(server);
    if (!entry?.client) throw new Error(`MCP server "${server}" is not connected`);
    return entry.client.callTool({ name: tool, arguments: args }, undefined, {
      signal,
      timeout: TOOL_TIMEOUT_MS,
      maxTotalTimeout: TOOL_MAX_TOTAL_MS,
      resetTimeoutOnProgress: true,
      // Asking for progress lets long-running tools keep the call alive and report status.
      onprogress: (progress) => onProgress?.(progress),
    });
  }

  async closeAll() {
    await Promise.all([...this.servers.values()].map((e) => this._disconnect(e)));
  }
}
