import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHmac, randomBytes } from 'node:crypto';
import ssh2 from 'ssh2';
import { SshPool, OutputCollector, checkKnownHosts, cleanOutput, ensureKeyPair, shellQuote } from '../servers/lib/ssh.js';
import { startSshServer } from './helpers/ssh-server.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-test-'));
const client = ensureKeyPair(path.join(tmp, 'id_ed25519'), 'test');
let server;
let pool;
let target;

before(async () => {
  server = await startSshServer({ authorizedKeys: () => [client.publicKey], cwd: tmp });
  pool = new SshPool();
  target = { host: '127.0.0.1', port: server.port, username: 'root', privateKey: client.privateKey };
});

after(async () => {
  pool.closeAll();
  await server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const off = { mode: 'off' };

test('runs a command and captures stdout, stderr and exit code', async () => {
  const r = await pool.exec(target, 'echo out; echo err >&2; exit 3', { hostKeys: off });
  assert.equal(r.code, 3);
  assert.equal(r.stdout, 'out\n');
  assert.equal(r.stderr, 'err\n');
  assert.equal(r.timedOut, false);
});

test('reuses the pooled connection', async () => {
  await pool.exec(target, 'true', { hostKeys: off });
  const before = pool.connections.size;
  await pool.exec(target, 'true', { hostKeys: off });
  assert.equal(pool.connections.size, before);
});

test('passes stdin and handles quoting (as ssh_write_file does)', async () => {
  const file = path.join(tmp, "dir with 'quote'", 'f.txt');
  const r = await pool.exec(target, `mkdir -p -- ${shellQuote(path.dirname(file))} && cat > ${shellQuote(file)}`, {
    stdin: 'hello\nworld',
    hostKeys: off,
  });
  assert.equal(r.code, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), 'hello\nworld');
});

test('stops commands that run past the timeout', async () => {
  const started = Date.now();
  const r = await pool.exec(target, 'sleep 30', { timeoutMs: 500, hostKeys: off });
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - started < 10_000);
});

test('rejects a key that is not authorized', async () => {
  const other = ensureKeyPair(path.join(tmp, 'other'), 'other');
  const p = new SshPool();
  const err = await p.exec({ ...target, privateKey: other.privateKey }, 'true', { hostKeys: off }).then(() => null, (e) => e);
  assert.ok(err, 'login with an unauthorized key should fail');
  assert.match(err.message, /authentication/i, `unexpected error: ${err.message}`);
  p.closeAll();
});

test('verifies host keys against known_hosts', async () => {
  const knownHostsPath = path.join(tmp, 'known_hosts');
  const entry = `[127.0.0.1]:${server.port}`;
  const wrongKey = ssh2.utils.parseKey(ssh2.utils.generateKeyPairSync('ed25519').public).getPublicSSH().toString('base64');

  fs.writeFileSync(knownHostsPath, `${entry} ssh-ed25519 ${wrongKey}\n`);
  const p1 = new SshPool();
  await assert.rejects(p1.exec(target, 'true', { hostKeys: { mode: 'known_hosts', knownHostsPath } }), /does not match known_hosts/);

  // Hashed entry with the right key is accepted.
  const salt = randomBytes(20);
  const hash = createHmac('sha1', salt).update(entry).digest('base64');
  fs.writeFileSync(knownHostsPath, `|1|${salt.toString('base64')}|${hash} ssh-ed25519 ${server.hostKeyBase64}\n`);
  const p2 = new SshPool();
  assert.equal((await p2.exec(target, 'echo ok', { hostKeys: { mode: 'known_hosts', knownHostsPath } })).stdout, 'ok\n');

  // Unknown hosts are refused only in strict mode.
  fs.writeFileSync(knownHostsPath, '');
  const p3 = new SshPool();
  await assert.rejects(p3.exec(target, 'true', { hostKeys: { mode: 'strict', knownHostsPath } }), /not in known_hosts/);
  const p4 = new SshPool();
  assert.equal((await p4.exec(target, 'true', { hostKeys: { mode: 'known_hosts', knownHostsPath } })).code, 0);
  for (const p of [p1, p2, p3, p4]) p.closeAll();
});

test('checkKnownHosts handles patterns, negation and other key types', () => {
  const key = ssh2.utils.parseKey(ssh2.utils.generateKeyPairSync('ed25519').public).getPublicSSH();
  const b64 = key.toString('base64');
  assert.equal(checkKnownHosts(`*.example.com ssh-ed25519 ${b64}`, 'a.example.com', 22, key), 'match');
  assert.equal(checkKnownHosts(`*.example.com,!bad.example.com ssh-ed25519 ${b64}`, 'bad.example.com', 22, key), 'unknown');
  assert.equal(checkKnownHosts(`host ssh-rsa AAAA`, 'host', 22, key), 'unknown');
  assert.equal(checkKnownHosts(`host ssh-ed25519 ${b64}`, 'host', 2222, key), 'unknown');
});

test('OutputCollector keeps the head and tail of long output', () => {
  const c = new OutputCollector(10, 10);
  c.push('0123456789');
  c.push('x'.repeat(100));
  c.push('abcdefghij');
  const s = c.toString();
  assert.ok(s.startsWith('0123456789'));
  assert.ok(s.endsWith('abcdefghij'));
  assert.match(s, /\[100 bytes omitted\]/);
});

test('cleanOutput strips colors and progress-bar redraws', () => {
  assert.equal(cleanOutput('\x1b[32mgreen\x1b[0m\n10%\r50%\r100%\ndone'), 'green\n100%\ndone');
});
