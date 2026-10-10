// SSH client helpers shared by the ssh and vast MCP servers: credential loading,
// known_hosts verification, pooled connections and command execution.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, createHmac } from 'node:crypto';
import ssh2 from 'ssh2';

const { Client, utils } = ssh2;

const IDLE_CLOSE_MS = 5 * 60_000;
const READY_TIMEOUT_MS = 20_000;
const PROGRESS_EVERY_MS = 10_000;

export const expandHome = (p) => (p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);

/** Quotes a string for a POSIX shell. */
export const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * Wraps a command to run as a normal user in a login shell, creating the user if needed
 * (for installers and apps that refuse to run as root). `user` must be a safe username.
 */
export function asUser(user, command) {
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(user)) throw new Error(`Invalid username: ${user}`);
  if (user === 'root') throw new Error('run_as_user must be a normal user such as "user"; leave it out to run as root.');
  return `{ id -u ${user} >/dev/null 2>&1 || useradd -m -s /bin/bash ${user}; } && runuser -l ${user} -c ${shellQuote(command)}`;
}

/** Strips ANSI escapes and collapses carriage-return progress bars to their final state. */
export function cleanOutput(s) {
  return s
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '')
    .split('\n')
    .map((line) => {
      const parts = line.split('\r').filter(Boolean);
      return parts.length ? parts[parts.length - 1] : '';
    })
    .join('\n');
}

/** Keeps the start and the end of a long output stream, dropping the middle. */
export class OutputCollector {
  constructor(headMax = 6_000, tailMax = 20_000) {
    this.headMax = headMax;
    this.tailMax = tailMax;
    this.head = [];
    this.headLen = 0;
    this.tail = Buffer.alloc(0);
    this.total = 0;
  }

  push(chunk) {
    let buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.total += buf.length;
    if (this.headLen < this.headMax) {
      const take = buf.subarray(0, this.headMax - this.headLen);
      this.head.push(take);
      this.headLen += take.length;
      buf = buf.subarray(take.length);
    }
    if (buf.length) {
      this.tail = Buffer.concat([this.tail, buf]);
      if (this.tail.length > this.tailMax) this.tail = this.tail.subarray(this.tail.length - this.tailMax);
    }
  }

  toString() {
    const head = Buffer.concat(this.head).toString('utf8');
    const omitted = this.total - this.headLen - this.tail.length;
    const out = omitted > 0 ? `${head}\n… [${omitted} bytes omitted] …\n${this.tail.toString('utf8')}` : head + this.tail.toString('utf8');
    return cleanOutput(out);
  }
}

// ---- known_hosts ------------------------------------------------------------

const glob = (pattern, value) =>
  new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i').test(value);

function hostMatches(patterns, entryHost) {
  if (patterns.startsWith('|1|')) {
    const [, , salt, hash] = patterns.split('|');
    if (!salt || !hash) return false;
    return createHmac('sha1', Buffer.from(salt, 'base64')).update(entryHost).digest('base64') === hash;
  }
  let matched = false;
  for (const p of patterns.split(',')) {
    if (p.startsWith('!')) {
      if (glob(p.slice(1), entryHost)) return false;
    } else if (glob(p, entryHost)) {
      matched = true;
    }
  }
  return matched;
}

const keyTypeOf = (keyBlob) => keyBlob.subarray(4, 4 + keyBlob.readUInt32BE(0)).toString();

export const fingerprint = (keyBlob) => `SHA256:${createHash('sha256').update(keyBlob).digest('base64').replace(/=+$/, '')}`;

/**
 * Checks a host key against OpenSSH known_hosts content.
 * @returns {'match' | 'mismatch' | 'unknown'}
 */
export function checkKnownHosts(content, host, port, keyBlob) {
  const entryHost = port === 22 ? host : `[${host}]:${port}`;
  const type = keyTypeOf(keyBlob);
  let mismatch = false;
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('@')) continue;
    const [patterns, keyType, keyB64] = line.split(/\s+/);
    if (!keyB64 || keyType !== type || !hostMatches(patterns, entryHost)) continue;
    if (Buffer.from(keyB64, 'base64').equals(keyBlob)) return 'match';
    mismatch = true;
  }
  return mismatch ? 'mismatch' : 'unknown';
}

// ---- credentials -------------------------------------------------------------

/** Loads a private key, returning null (with a reason) if it can't be used. */
export function loadPrivateKey(keyPath, passphrase) {
  const file = expandHome(keyPath);
  if (!file || !fs.existsSync(file)) return { key: null, reason: `${keyPath} not found` };
  const data = fs.readFileSync(file);
  const parsed = utils.parseKey(data, passphrase || undefined);
  if (parsed instanceof Error) return { key: null, reason: `${keyPath}: ${parsed.message}` };
  return { key: data, parsed: Array.isArray(parsed) ? parsed[0] : parsed, path: file };
}

export function defaultKeyPath() {
  for (const name of ['id_ed25519', 'id_ecdsa', 'id_rsa']) {
    const p = path.join(os.homedir(), '.ssh', name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** Formats a parsed key's public half as an OpenSSH authorized_keys line. */
export const publicKeyLine = (parsed, comment = '') =>
  `${parsed.type} ${parsed.getPublicSSH().toString('base64')}${comment ? ` ${comment}` : ''}`;

/** Creates (once) and loads a dedicated ed25519 key pair at `keyPath`. */
export function ensureKeyPair(keyPath, comment) {
  if (!fs.existsSync(keyPath)) {
    fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
    const pair = utils.generateKeyPairSync('ed25519', { comment });
    fs.writeFileSync(keyPath, pair.private, { mode: 0o600 });
    fs.writeFileSync(`${keyPath}.pub`, `${pair.public}\n`, { mode: 0o644 });
  }
  const loaded = loadPrivateKey(keyPath);
  if (!loaded.key) throw new Error(`Could not load SSH key ${keyPath}: ${loaded.reason}`);
  return { privateKey: loaded.key, publicKey: publicKeyLine(loaded.parsed, comment) };
}

// ---- connections -------------------------------------------------------------

/**
 * A pool of SSH connections keyed by user@host:port, closed after 5 idle minutes.
 *
 * target: { host, port, username, privateKey?, passphrase?, agent?, password? }
 * hostKeys: { mode: 'off' | 'known_hosts' | 'strict', knownHostsPath? }
 */
export class SshPool {
  constructor() {
    this.connections = new Map();
  }

  keyFor(t) {
    return `${t.username}@${t.host}:${t.port}`;
  }

  async connect(target, hostKeys = { mode: 'known_hosts' }) {
    const key = this.keyFor(target);
    const existing = this.connections.get(key);
    if (existing) {
      this._touch(key);
      return existing.ready;
    }
    if (!target.privateKey && !target.agent && !target.password) {
      throw new Error('No SSH credentials: set SSH_KEY_PATH, run an ssh-agent (SSH_AUTH_SOCK), or give the host a password in SSH_HOSTS_FILE.');
    }

    const conn = new Client();
    let rejection = null;
    const entry = { conn, timer: null };
    entry.ready = new Promise((resolve, reject) => {
      conn.on('ready', () => resolve(conn));
      conn.on('error', (err) => {
        this._drop(key, conn);
        reject(rejection ? new Error(rejection) : err);
      });
      conn.on('close', () => {
        this._drop(key, conn);
        reject(new Error(rejection || `Connection to ${key} closed`));
      });
    });
    this.connections.set(key, entry);
    this._touch(key);

    const hostVerifier = (keyBlob) => {
      if (hostKeys.mode === 'off') return true;
      let content = '';
      try {
        content = fs.readFileSync(expandHome(hostKeys.knownHostsPath || '~/.ssh/known_hosts'), 'utf8');
      } catch {
        // No known_hosts file.
      }
      const result = checkKnownHosts(content, target.host, target.port, keyBlob);
      if (result === 'match') return true;
      if (result === 'mismatch') {
        rejection =
          `Host key for ${target.host}:${target.port} (${fingerprint(keyBlob)}) does not match known_hosts. ` +
          'This may be a man-in-the-middle attack. If the host was rebuilt, remove its old line from known_hosts.';
        return false;
      }
      if (hostKeys.mode === 'strict') {
        rejection = `${target.host}:${target.port} is not in known_hosts (${fingerprint(keyBlob)}) and strict host key checking is on.`;
        return false;
      }
      return true;
    };

    try {
      conn.connect({
        host: target.host,
        port: target.port,
        username: target.username,
        privateKey: target.privateKey || undefined,
        passphrase: target.passphrase || undefined,
        agent: target.agent || undefined,
        password: target.password || undefined,
        readyTimeout: READY_TIMEOUT_MS,
        keepaliveInterval: 15_000,
        hostVerifier,
      });
    } catch (err) {
      this._drop(key, conn);
      throw err;
    }
    return entry.ready;
  }

  _touch(key) {
    const entry = this.connections.get(key);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => this.close(key), IDLE_CLOSE_MS);
    entry.timer.unref?.();
  }

  _drop(key, conn) {
    const entry = this.connections.get(key);
    if (entry && entry.conn === conn) {
      clearTimeout(entry.timer);
      this.connections.delete(key);
    }
  }

  close(key) {
    const entry = this.connections.get(key);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.connections.delete(key);
    entry.conn.end();
  }

  closeAll() {
    for (const key of [...this.connections.keys()]) this.close(key);
  }

  /**
   * Starts a command and resolves with its channel (stdin, stdout and .stderr) for a
   * long-lived conversation, such as an MCP server over stdio.
   */
  async spawn(target, command, { hostKeys } = {}) {
    const conn = await this.connect(target, hostKeys);
    const key = this.keyFor(target);
    return new Promise((resolve, reject) => {
      conn.exec(command, (err, stream) => {
        if (err) return reject(err);
        // An open channel keeps its connection from being closed as idle.
        const keepAlive = setInterval(() => this._touch(key), 60_000);
        stream.on('close', () => clearInterval(keepAlive));
        resolve(stream);
      });
    });
  }

  /**
   * Runs a command. Resolves with { code, signal, stdout, stderr, timedOut }; rejects only
   * if the command could not be started (connection or auth failure).
   */
  async exec(target, command, { timeoutMs = 120_000, stdin, signal, onProgress, hostKeys, stdoutLimit } = {}) {
    const conn = await this.connect(target, hostKeys);
    const key = this.keyFor(target);
    return new Promise((resolve, reject) => {
      conn.exec(command, (err, stream) => {
        if (err) return reject(err);
        // stdoutLimit keeps up to that many bytes whole (e.g. a base64 screenshot) instead of head + tail.
        const stdout = stdoutLimit ? new OutputCollector(stdoutLimit, 0) : new OutputCollector();
        const stderr = new OutputCollector();
        let code = null;
        let exitSignal = null;
        let timedOut = false;
        const started = Date.now();
        const stop = () => {
          stream.signal?.('KILL');
          stream.close();
        };
        const timer = setTimeout(() => {
          timedOut = true;
          stop();
        }, timeoutMs);
        const ticker = setInterval(() => {
          this._touch(key);
          onProgress?.(`running for ${Math.round((Date.now() - started) / 1000)}s, ${stdout.total + stderr.total} bytes of output`);
        }, PROGRESS_EVERY_MS);
        const onAbort = () => stop();
        signal?.addEventListener('abort', onAbort, { once: true });

        stream.on('data', (d) => stdout.push(d));
        stream.stderr.on('data', (d) => stderr.push(d));
        stream.on('exit', (c, s) => {
          code = c ?? null;
          exitSignal = s ?? null;
        });
        stream.on('close', () => {
          clearTimeout(timer);
          clearInterval(ticker);
          signal?.removeEventListener('abort', onAbort);
          this._touch(key);
          if (signal?.aborted) return reject(new Error('Cancelled'));
          resolve({ code, signal: exitSignal, stdout: stdout.toString(), stderr: stderr.toString(), timedOut });
        });
        // Always close stdin so commands that read it don't hang.
        if (stdin != null) stream.end(stdin);
        else stream.end();
      });
    });
  }
}

/** Formats an exec result for the model. */
export function formatExecResult(where, command, r, timeoutMs) {
  const lines = [`$ ${command}`, `(on ${where})`];
  if (r.timedOut) lines.push(`TIMED OUT after ${Math.round(timeoutMs / 1000)}s — the command was stopped. Use a larger timeout_seconds, or run it in the background with nohup.`);
  else lines.push(`exit code: ${r.code ?? (r.signal ? `killed by ${r.signal}` : 'unknown')}`);
  if (r.stdout.trim()) lines.push('--- stdout ---', r.stdout.trimEnd());
  if (r.stderr.trim()) lines.push('--- stderr ---', r.stderr.trimEnd());
  if (!r.stdout.trim() && !r.stderr.trim()) lines.push('(no output)');
  return lines.join('\n');
}
