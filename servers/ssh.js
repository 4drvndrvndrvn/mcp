#!/usr/bin/env node
// MCP server that runs commands and reads/writes files on remote hosts over SSH.
//
// Settings (from .env or the environment):
//   SSH_KEY_PATH          private key (default: ~/.ssh/id_ed25519, id_ecdsa or id_rsa)
//   SSH_KEY_PASSPHRASE    passphrase for that key
//   SSH_AUTH_SOCK         ssh-agent socket (passed through by mcp-servers.json)
//   SSH_HOSTS_FILE        JSON file of named hosts: {"gpu": {"host": "1.2.3.4", "port": 22, "username": "root"}}
//   SSH_ALLOWED_HOSTS     comma-separated hostname patterns the model may connect to (e.g. "*.vast.ai,10.0.0.*")
//   SSH_DEFAULT_USER      username when none is given (default: root)
//   SSH_STRICT_HOST_KEY_CHECKING=yes  refuse hosts that aren't in known_hosts

import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadEnv, safe, text, progressReporter } from './lib/common.js';
import {
  SshPool,
  defaultKeyPath,
  expandHome,
  formatExecResult,
  loadPrivateKey,
  publicKeyLine,
  shellQuote,
} from './lib/ssh.js';

loadEnv();

const env = process.env;
const defaultUser = env.SSH_DEFAULT_USER || 'root';
const allowed = (env.SSH_ALLOWED_HOSTS || '').split(',').map((s) => s.trim()).filter(Boolean);
const hostKeys = {
  mode: /^(yes|true|1)$/i.test(env.SSH_STRICT_HOST_KEY_CHECKING || '') ? 'strict' : 'known_hosts',
  knownHostsPath: env.SSH_KNOWN_HOSTS || '~/.ssh/known_hosts',
};

let namedHosts = {};
if (env.SSH_HOSTS_FILE) {
  try {
    namedHosts = JSON.parse(fs.readFileSync(expandHome(env.SSH_HOSTS_FILE), 'utf8'));
  } catch (err) {
    console.error(`[ssh] could not read SSH_HOSTS_FILE: ${err.message}`);
  }
}

const keyPath = env.SSH_KEY_PATH || defaultKeyPath();
const defaultKey = keyPath ? loadPrivateKey(keyPath, env.SSH_KEY_PASSPHRASE) : { key: null, reason: 'no key found in ~/.ssh' };
if (!defaultKey.key) console.error(`[ssh] no usable private key (${defaultKey.reason})`);

const pool = new SshPool();

const matchesPattern = (pattern, value) =>
  new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i').test(value);

/** Resolves "name", "host", "user@host" or "user@host:port" into a connection target. */
function resolveTarget(hostArg, { port, username } = {}) {
  const named = namedHosts[hostArg];
  if (named) {
    const key = named.privateKeyPath ? loadPrivateKey(named.privateKeyPath, named.passphrase) : defaultKey;
    return {
      host: named.host,
      port: Number(port || named.port || 22),
      username: username || named.username || defaultUser,
      privateKey: key.key,
      passphrase: named.privateKeyPath ? named.passphrase : env.SSH_KEY_PASSPHRASE,
      password: named.password,
      agent: env.SSH_AUTH_SOCK || undefined,
    };
  }

  let host = String(hostArg).trim();
  let user = username;
  let p = port;
  const at = host.lastIndexOf('@');
  if (at > 0) {
    user ||= host.slice(0, at);
    host = host.slice(at + 1);
  }
  const bracketed = host.match(/^\[(.+)\]:(\d+)$/);
  if (bracketed) {
    host = bracketed[1];
    p ||= Number(bracketed[2]);
  } else if (/^[^:]+:\d+$/.test(host)) {
    const [h, portPart] = host.split(':');
    host = h;
    p ||= Number(portPart);
  }
  if (!host) throw new Error('host is required');
  if (allowed.length && !allowed.some((pattern) => matchesPattern(pattern, host))) {
    throw new Error(`${host} is not in SSH_ALLOWED_HOSTS (${allowed.join(', ')}).`);
  }
  return {
    host,
    port: Number(p || 22),
    username: user || defaultUser,
    privateKey: defaultKey.key,
    passphrase: env.SSH_KEY_PASSPHRASE,
    agent: env.SSH_AUTH_SOCK || undefined,
  };
}

const where = (t) => `${t.username}@${t.host}:${t.port}`;

const targetShape = {
  host: z.string().describe('A named host from SSH_HOSTS_FILE, a hostname/IP, or "user@host:port"'),
  port: z.number().int().min(1).max(65535).optional().describe('SSH port (default 22)'),
  username: z.string().optional().describe(`Login user (default ${defaultUser})`),
};

const server = new McpServer({ name: 'ssh', version: '1.0.0' });

server.registerTool(
  'ssh_exec',
  {
    title: 'Run a command over SSH',
    description:
      'Run a shell command on a remote host over SSH and return its exit code, stdout and stderr. ' +
      'Each call is a fresh non-interactive shell, so chain steps with && or cd first. ' +
      'For long jobs, raise timeout_seconds or start them with nohup ... & and check back later.',
    inputSchema: {
      ...targetShape,
      command: z.string().describe('Shell command to run'),
      timeout_seconds: z.number().int().min(1).max(3600).optional().describe('Stop the command after this long (default 120)'),
    },
    annotations: { destructiveHint: true, openWorldHint: true },
  },
  safe(async ({ host, port, username, command, timeout_seconds = 120 }, extra) => {
    const target = resolveTarget(host, { port, username });
    const timeoutMs = timeout_seconds * 1000;
    const r = await pool.exec(target, command, {
      timeoutMs,
      signal: extra.signal,
      onProgress: progressReporter(extra),
      hostKeys,
    });
    return text(formatExecResult(where(target), command, r, timeoutMs), r.timedOut);
  }),
);

server.registerTool(
  'ssh_read_file',
  {
    title: 'Read a remote file',
    description: 'Read a text file on a remote host over SSH.',
    inputSchema: {
      ...targetShape,
      path: z.string().describe('Path of the file on the remote host'),
      max_bytes: z.number().int().min(1).max(1_000_000).optional().describe('Read at most this many bytes (default 100000)'),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  safe(async ({ host, port, username, path: filePath, max_bytes = 100_000 }, extra) => {
    const target = resolveTarget(host, { port, username });
    const r = await pool.exec(target, `head -c ${max_bytes + 1} -- ${shellQuote(filePath)}`, { signal: extra.signal, hostKeys });
    if (r.code !== 0) return text(`Could not read ${filePath} on ${where(target)}: ${r.stderr.trim() || `exit code ${r.code}`}`, true);
    const truncated = Buffer.byteLength(r.stdout) > max_bytes;
    return text(`${filePath} on ${where(target)}${truncated ? ` (first ${max_bytes} bytes)` : ''}:\n${r.stdout}`);
  }),
);

server.registerTool(
  'ssh_write_file',
  {
    title: 'Write a remote file',
    description: 'Create or overwrite (or append to) a text file on a remote host over SSH. Parent directories are created.',
    inputSchema: {
      ...targetShape,
      path: z.string().describe('Path of the file on the remote host'),
      content: z.string().describe('File contents'),
      append: z.boolean().optional().describe('Append instead of overwriting'),
    },
    annotations: { destructiveHint: true, openWorldHint: true },
  },
  safe(async ({ host, port, username, path: filePath, content, append = false }, extra) => {
    const target = resolveTarget(host, { port, username });
    const dir = path.posix.dirname(filePath);
    const command = `mkdir -p -- ${shellQuote(dir)} && cat ${append ? '>>' : '>'} ${shellQuote(filePath)}`;
    const r = await pool.exec(target, command, { stdin: content, signal: extra.signal, hostKeys });
    if (r.code !== 0) return text(`Could not write ${filePath} on ${where(target)}: ${r.stderr.trim() || `exit code ${r.code}`}`, true);
    return text(`${append ? 'Appended' : 'Wrote'} ${Buffer.byteLength(content)} bytes to ${filePath} on ${where(target)}.`);
  }),
);

server.registerTool(
  'ssh_list_hosts',
  {
    title: 'List SSH hosts',
    description: 'List the named SSH hosts and the SSH settings (default user, allowed hosts, credentials) this server uses.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  safe(async () => {
    const lines = [];
    const names = Object.keys(namedHosts);
    lines.push(names.length ? 'Named hosts:' : 'No named hosts (set SSH_HOSTS_FILE to add some). Any hostname can be used directly.');
    for (const name of names) {
      const h = namedHosts[name];
      lines.push(`- ${name}: ${h.username || defaultUser}@${h.host}:${h.port || 22}`);
    }
    lines.push(`Default user: ${defaultUser}`);
    lines.push(`Allowed hosts: ${allowed.length ? allowed.join(', ') : 'any'}`);
    lines.push(`Private key: ${defaultKey.key ? defaultKey.path : `none (${defaultKey.reason})`}`);
    lines.push(`ssh-agent: ${env.SSH_AUTH_SOCK ? 'yes' : 'no'}`);
    lines.push(`Host key checking: ${hostKeys.mode}`);
    return text(lines.join('\n'));
  }),
);

server.registerTool(
  'ssh_public_key',
  {
    title: 'Show SSH public key',
    description: "Return the public key for this server's private key, e.g. to add to a host's ~/.ssh/authorized_keys.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  safe(async () => {
    if (!defaultKey.key) return text(`No private key configured (${defaultKey.reason}).`, true);
    return text(publicKeyLine(defaultKey.parsed, 'nanogpt-mcp-chat'));
  }),
);

process.on('SIGTERM', () => {
  pool.closeAll();
  process.exit(0);
});

await server.connect(new StdioServerTransport());
