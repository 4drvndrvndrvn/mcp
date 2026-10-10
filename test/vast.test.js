import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { VastAPI, sshEndpoints, formatOffer, formatTemplate, buildCreatePayload, startupProblem, templateHasSsh } from '../servers/lib/vast.js';
import { startVastMock, DESKTOP_TEMPLATE, NO_SSH_TEMPLATE } from './helpers/vast-mock.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vast-test-'));
let mock;

async function connect(env) {
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(ROOT, 'servers/vast.js')],
      env: {
        VAST_API_URL: mock.url,
        VAST_SSH_KEY_PATH: path.join(tmp, 'vast_key'),
        VAST_AUTO_DESTROY_FILE: path.join(tmp, 'auto-destroy.json'),
        VAST_POLL_MS: '100',
        ...env,
      },
      stderr: 'pipe',
    }),
  );
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return { text: r.content.map((c) => c.text).join('\n'), isError: Boolean(r.isError) };
  };
  return { client, call };
}

before(async () => {
  mock = await startVastMock({ bootMs: 400 });
});

after(async () => {
  await mock.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('desktop flow: find template, rent, wait, run a command, destroy', async () => {
  const { client, call } = await connect({ VAST_API_KEY: 'test-key' });
  try {
    const tools = (await client.listTools()).tools;
    const readOnly = Object.fromEntries(tools.map((t) => [t.name, t.annotations?.readOnlyHint === true]));
    assert.equal(readOnly.vast_create_instance, false);
    assert.equal(readOnly.vast_destroy_instance, false);
    assert.equal(readOnly.vast_exec, false);
    assert.equal(readOnly.vast_search_offers, true);

    const templates = await call('vast_search_templates', { query: 'desktop' });
    assert.match(templates.text, new RegExp(DESKTOP_TEMPLATE.hash_id));
    assert.doesNotMatch(templates.text, /PyTorch/);

    const offers = await call('vast_search_offers', { template_hash: DESKTOP_TEMPLATE.hash_id, max_price_per_hour: 1 });
    assert.match(offers.text, /offer 1001: 1x RTX 3060/);
    assert.match(offers.text, /include 32 GB disk/);
    const search = mock.requests.findLast((r) => r.path === '/api/v0/bundles/');
    assert.deepEqual(search.body.compute_cap, { gte: 750 }, 'template filters are applied');
    assert.deepEqual(search.body.order, [['dph_total', 'asc']]);

    const created = await call('vast_create_instance', { offer_id: 1001, template_hash: DESKTOP_TEMPLATE.hash_id, label: 'tuxbox' });
    assert.equal(created.isError, false, created.text);
    const id = Number(created.text.match(/Created instance (\d+)/)[1]);
    const inst = mock.instances.get(id);
    assert.equal(inst.payload.template_hash_id, DESKTOP_TEMPLATE.hash_id);
    assert.equal(inst.payload.client_id, 'me');
    assert.equal(inst.payload.disk, 32);
    assert.equal(inst.payload.image, null);
    assert.equal(inst.keys.length, 1, 'our SSH key was attached');

    const exec0 = await call('vast_exec', { instance_id: id, command: 'echo early' });
    assert.equal(exec0.isError, true, 'exec before the instance is running is refused');

    const ready = await call('vast_wait_for_instance', { instance_id: id, timeout_seconds: 30 });
    assert.equal(ready.isError, false, ready.text);
    assert.match(ready.text, /reachable over SSH \(proxy\)/);

    const exec = await call('vast_exec', { instance_id: id, command: 'mkdir -p dl && cd dl && echo tuxbox > tuxbox.txt && cat tuxbox.txt' });
    assert.equal(exec.isError, false, exec.text);
    assert.match(exec.text, /exit code: 0/);
    assert.match(exec.text, /--- stdout ---\ntuxbox/);

    const logs = await call('vast_instance_logs', { instance_id: id });
    assert.match(logs.text, /onstart done/);

    const destroyed = await call('vast_destroy_instance', { instance_id: id });
    assert.match(destroyed.text, /Destroyed instance/);
    assert.equal(mock.instances.has(id), false);

    const gone = await call('vast_get_instance', { instance_id: id });
    assert.equal(gone.isError, true);
    assert.match(gone.text, /not found/);
  } finally {
    await client.close();
  }
});

test('without VAST_API_KEY searching works and renting explains how to add a key', async () => {
  const { client, call } = await connect({ VAST_API_KEY: '' });
  try {
    assert.equal((await call('vast_search_offers', {})).isError, false);
    const r = await call('vast_create_instance', { offer_id: 1001, image: 'ubuntu' });
    assert.equal(r.isError, true);
    assert.match(r.text, /VAST_API_KEY is not set/);
  } finally {
    await client.close();
  }
});

test('VAST_MAX_PRICE_PER_HOUR blocks expensive rentals', async () => {
  const { client, call } = await connect({ VAST_API_KEY: 'test-key', VAST_MAX_PRICE_PER_HOUR: '1' });
  try {
    const r = await call('vast_create_instance', { offer_id: 1002, image: 'ubuntu' });
    assert.equal(r.isError, true);
    assert.match(r.text, /above VAST_MAX_PRICE_PER_HOUR/);
    const ok = await call('vast_create_instance', { offer_id: 1001, image: 'vastai/base-image' });
    assert.equal(ok.isError, false, ok.text);
    const id = Number(ok.text.match(/Created instance (\d+)/)[1]);
    assert.equal(mock.instances.get(id).payload.runtype, 'ssh_direc ssh_proxy');
    await call('vast_destroy_instance', { instance_id: id });
  } finally {
    await client.close();
  }
});

test('VastAPI encodes query arguments like the vastai CLI', () => {
  const api = new VastAPI({ apiKey: 'k', baseUrl: 'https://console.vast.ai/' });
  assert.equal(api.url('/instances/1/', { owner: 'me' }), 'https://console.vast.ai/api/v0/instances/1/?owner=me');
  assert.equal(
    api.url('/api/v1/instances/', { limit: 25, select_filters: {} }),
    'https://console.vast.ai/api/v1/instances/?limit=25&select_filters=%7B%7D',
  );
});

test('sshEndpoints prefers direct ports and applies the jupyter proxy offset', () => {
  const inst = { public_ipaddr: '1.2.3.4', ports: { '22/tcp': [{ HostPort: '40022' }] }, ssh_host: 'ssh5.vast.ai', ssh_port: 12000, image_runtype: 'jupyter' };
  assert.deepEqual(sshEndpoints(inst), [
    { host: '1.2.3.4', port: 40022, kind: 'direct' },
    { host: 'ssh5.vast.ai', port: 12001, kind: 'proxy' },
  ]);
  assert.deepEqual(sshEndpoints({ ssh_host: 'ssh5.vast.ai', ssh_port: 12000, image_runtype: 'ssh_proxy' }), [
    { host: 'ssh5.vast.ai', port: 12000, kind: 'proxy' },
  ]);
});

test('formatters and payload builder', () => {
  assert.match(formatOffer({ id: 1, num_gpus: 1, gpu_name: 'RTX 4090', gpu_ram: 24564, dph_total: 0.39, reliability: 0.97 }), /offer 1: 1x RTX 4090 \(25 GB VRAM\) \| \$0\.390\/hr/);
  const p = buildCreatePayload({ image: 'x', disk: 20, runtype: 'ssh_proxy' });
  assert.equal(p.client_id, 'me');
  assert.equal(p.runtype, 'ssh_proxy');
  assert.equal(p.template_hash_id, null);
});

test('a template keeps its own startup script', async () => {
  const { client, call } = await connect({ VAST_API_KEY: 'test-key' });
  try {
    const r = await call('vast_create_instance', { offer_id: 1001, template_hash: DESKTOP_TEMPLATE.hash_id, onstart: 'echo hi' });
    assert.match(r.text, /onstart was ignored/);
    const id = Number(r.text.match(/Created instance (\d+)/)[1]);
    assert.equal(mock.instances.get(id).payload.onstart, null);
    await call('vast_destroy_instance', { instance_id: id });
  } finally {
    await client.close();
  }
});

const waitFor = async (check, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 50));
  }
};

test('auto_destroy_minutes destroys the instance when nobody else does', async () => {
  const { client, call } = await connect({ VAST_API_KEY: 'test-key' });
  try {
    const r = await call('vast_create_instance', { offer_id: 1001, image: 'ubuntu', auto_destroy_minutes: 0.01 });
    assert.match(r.text, /destroyed automatically in 0.01 minutes/);
    const id = Number(r.text.match(/Created instance (\d+)/)[1]);
    await waitFor(() => !mock.instances.has(id));
    await waitFor(() => !(String(id) in JSON.parse(fs.readFileSync(path.join(tmp, 'auto-destroy.json'), 'utf8'))));
  } finally {
    await client.close();
  }
});

test('an auto-destroy deadline that passed while the app was down runs at startup', async () => {
  const first = await connect({ VAST_API_KEY: 'test-key' });
  const r = await first.call('vast_create_instance', { offer_id: 1001, image: 'ubuntu', auto_destroy_minutes: 60 });
  const id = Number(r.text.match(/Created instance (\d+)/)[1]);
  await first.client.close();
  assert.ok(mock.instances.has(id));
  // Pretend the hour passed while nothing was running.
  fs.writeFileSync(path.join(tmp, 'auto-destroy.json'), JSON.stringify({ [id]: Date.now() - 1000 }));
  const second = await connect({ VAST_API_KEY: 'test-key' });
  try {
    await waitFor(() => !mock.instances.has(id));
  } finally {
    await second.client.close();
  }
});

test('vast_exec run_as_user wraps the command for a normal user', async () => {
  const dry = await startVastMock({ bootMs: 0, execHandler: (cmd) => (cmd === 'echo ready' ? { stdout: 'ready\n' } : { stdout: 'ok\n' }) });
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, 'servers/vast.js')],
    env: { VAST_API_URL: dry.url, VAST_API_KEY: 'test-key', VAST_SSH_KEY_PATH: path.join(tmp, 'vast_key'), VAST_AUTO_DESTROY_FILE: path.join(tmp, 'ad2.json'), VAST_POLL_MS: '50' },
  }));
  const call = async (name, args) => (await client.callTool({ name, arguments: args })).content[0].text;
  try {
    const id = Number((await call('vast_create_instance', { offer_id: 1001, image: 'ubuntu' })).match(/Created instance (\d+)/)[1]);
    await call('vast_wait_for_instance', { instance_id: id, timeout_seconds: 20 });
    const out = await call('vast_exec', { instance_id: id, command: 'bash install.sh', run_as_user: 'user' });
    assert.match(out, /as user/);
    assert.equal(dry.instances.get(id).ssh.commands.at(-1), "{ id -u user >/dev/null 2>&1 || useradd -m -s /bin/bash user; } && runuser -l user -c 'bash install.sh'");
    const bad = await client.callTool({ name: 'vast_exec', arguments: { instance_id: id, command: 'x', run_as_user: 'Root;x' } });
    assert.equal(bad.isError, true);
    // "root" just runs as root, unwrapped.
    const root = await call('vast_exec', { instance_id: id, command: 'whoami', run_as_user: 'root' });
    assert.match(root, /as root/);
    assert.equal(dry.instances.get(id).ssh.commands.at(-1), 'whoami');
    await call('vast_destroy_instance', { instance_id: id });
  } finally {
    await client.close();
    await dry.close();
  }
});

const createdId = (r) => Number(r.text.match(/Created instance (\d+)/)[1]);
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

test('vast_wait_for_instance gives up on an image that cannot be pulled', async () => {
  const { client, call } = await connect({ VAST_API_KEY: 'test-key' });
  try {
    const id = createdId(await call('vast_create_instance', { offer_id: 1001, image: 'bad/image' }));
    const r = await call('vast_wait_for_instance', { instance_id: id, timeout_seconds: 60 });
    assert.equal(r.isError, true);
    assert.match(r.text, /failed to start: Error response from daemon: pull access denied/);
    assert.match(r.text, /vast_destroy_instance/);
    await call('vast_destroy_instance', { instance_id: id });
  } finally {
    await client.close();
  }
});

test('vast_wait_for_instance gives up on a container that keeps exiting', async () => {
  const { client, call } = await connect({ VAST_API_KEY: 'test-key' });
  try {
    const id = createdId(await call('vast_create_instance', { offer_id: 1001, image: 'crash/image' }));
    const r = await call('vast_wait_for_instance', { instance_id: id, timeout_seconds: 60 });
    assert.equal(r.isError, true);
    assert.match(r.text, /failed to start: the instance is exited \(Exited \(1\)/);
    await call('vast_destroy_instance', { instance_id: id });
  } finally {
    await client.close();
  }
});

test('startupProblem only reports instances that should be starting', () => {
  assert.equal(startupProblem({ actual_status: 'loading', status_msg: 'Pulling image vastai/linux-desktop' }), null);
  assert.equal(startupProblem({ actual_status: 'running', status_msg: 'Error: something old' }), null);
  assert.equal(startupProblem({ actual_status: 'exited', intended_status: 'stopped' }), null);
  assert.deepEqual(startupProblem({ actual_status: 'loading', status_msg: 'Error response from daemon: manifest unknown' }), {
    kind: 'error',
    message: 'Error response from daemon: manifest unknown',
  });
  assert.equal(startupProblem({ actual_status: 'offline', intended_status: 'running' }).kind, 'down');
  assert.equal(startupProblem({ actual_status: 'exited', intended_status: 'running', status_msg: 'Exited (0)' }).kind, 'down');
});

test('templates without SSH are refused unless allow_no_ssh is set', async () => {
  const { client, call } = await connect({ VAST_API_KEY: 'test-key' });
  try {
    assert.equal(templateHasSsh(DESKTOP_TEMPLATE), true);
    assert.equal(templateHasSsh(NO_SSH_TEMPLATE), false);
    assert.match(formatTemplate(NO_SSH_TEMPLATE), /no SSH: vast_exec/);
    assert.doesNotMatch(formatTemplate(DESKTOP_TEMPLATE), /no SSH/);

    const rentals = () => mock.requests.filter((r) => r.path.startsWith('/api/v0/asks/')).length;
    const before = rentals();
    const refused = await call('vast_create_instance', { offer_id: 1001, template_hash: NO_SSH_TEMPLATE.hash_id });
    assert.equal(refused.isError, true);
    assert.match(refused.text, /has no SSH .*Nothing was rented/);
    assert.equal(rentals(), before, 'nothing was rented');

    const created = await call('vast_create_instance', { offer_id: 1001, template_hash: NO_SSH_TEMPLATE.hash_id, allow_no_ssh: true });
    assert.equal(created.isError, false, created.text);
    assert.match(created.text, /no SSH, so vast_exec won't work/);
    const id = createdId(created);

    const ready = await call('vast_wait_for_instance', { instance_id: id, timeout_seconds: 30 });
    assert.equal(ready.isError, false, ready.text);
    assert.match(ready.text, /is running\. Its launch mode \(args\) has no SSH/);
    const exec = await call('vast_exec', { instance_id: id, command: 'echo hi' });
    assert.equal(exec.isError, true);
    assert.match(exec.text, /has no SSH/);
    await call('vast_destroy_instance', { instance_id: id });
  } finally {
    await client.close();
  }
});

test('new instances get a 120 minute auto-destroy by default, and 0 opts out', async () => {
  const file = path.join(tmp, 'defaults.json');
  const { client, call } = await connect({ VAST_API_KEY: 'test-key', VAST_AUTO_DESTROY_FILE: file });
  try {
    const tool = (await client.listTools()).tools.find((t) => t.name === 'vast_create_instance');
    assert.match(tool.inputSchema.properties.auto_destroy_minutes.description, /Default: 120\./);

    const plain = await call('vast_create_instance', { offer_id: 1001, image: 'ubuntu' });
    assert.match(plain.text, /destroyed automatically in 120 minutes/);
    const a = createdId(plain);
    const deadline = readJson(file)[a];
    assert.ok(Math.abs(deadline - (Date.now() + 120 * 60_000)) < 60_000);

    const never = await call('vast_create_instance', { offer_id: 1001, image: 'ubuntu', auto_destroy_minutes: 0 });
    assert.equal(never.isError, false, never.text);
    assert.doesNotMatch(never.text, /destroyed automatically/);
    const b = createdId(never);
    assert.equal(String(b) in readJson(file), false);
    await call('vast_destroy_instance', { instance_id: a });
    await call('vast_destroy_instance', { instance_id: b });
  } finally {
    await client.close();
  }

  const off = await connect({ VAST_API_KEY: 'test-key', VAST_AUTO_DESTROY_FILE: file, VAST_AUTO_DESTROY_MINUTES: '0' });
  try {
    const tool = (await off.client.listTools()).tools.find((t) => t.name === 'vast_create_instance');
    assert.match(tool.inputSchema.properties.auto_destroy_minutes.description, /Default: never\./);
    const r = await off.call('vast_create_instance', { offer_id: 1001, image: 'ubuntu' });
    assert.doesNotMatch(r.text, /destroyed automatically/);
    await off.call('vast_destroy_instance', { instance_id: createdId(r) });
  } finally {
    await off.client.close();
  }
});

test('two copies of the server share the auto-destroy file without losing deadlines', async () => {
  const file = path.join(tmp, 'shared.json');
  const env = { VAST_API_KEY: 'test-key', VAST_AUTO_DESTROY_FILE: file };
  const a = await connect(env);
  const b = await connect(env);
  try {
    const x = createdId(await a.call('vast_create_instance', { offer_id: 1001, image: 'ubuntu', auto_destroy_minutes: 60 }));
    const y = createdId(await b.call('vast_create_instance', { offer_id: 1001, image: 'ubuntu', auto_destroy_minutes: 60 }));
    assert.deepEqual(Object.keys(readJson(file)).map(Number).sort(), [x, y].sort(), "b kept a's deadline");

    // a's timers fire in ~1 s, but b moves one deadline later and cancels the other.
    const moved = createdId(await a.call('vast_create_instance', { offer_id: 1001, image: 'ubuntu', auto_destroy_minutes: 0.02 }));
    const cancelled = createdId(await a.call('vast_create_instance', { offer_id: 1001, image: 'ubuntu', auto_destroy_minutes: 0.02 }));
    assert.equal((await b.call('vast_set_auto_destroy', { instance_id: moved, minutes: 60 })).isError, false);
    assert.equal((await b.call('vast_set_auto_destroy', { instance_id: cancelled, minutes: 0 })).isError, false);
    await pause(2500);
    assert.ok(mock.instances.has(moved), 'a respected the later deadline');
    assert.ok(mock.instances.has(cancelled), 'a respected the cancellation');
    const saved = readJson(file);
    assert.ok(saved[moved] > Date.now() + 50 * 60_000);
    assert.equal(String(cancelled) in saved, false);

    for (const id of [x, y, moved, cancelled]) await a.call('vast_destroy_instance', { instance_id: id });
    assert.deepEqual(readJson(file), {});
  } finally {
    await a.client.close();
    await b.client.close();
  }
});

test('an instance rented while the call was being cancelled is destroyed', async () => {
  const slow = await startVastMock({ bootMs: 0, createDelayMs: 600 });
  const file = path.join(tmp, 'cancel.json');
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, 'servers/vast.js')],
    env: { VAST_API_URL: slow.url, VAST_API_KEY: 'test-key', VAST_SSH_KEY_PATH: path.join(tmp, 'vast_key'), VAST_AUTO_DESTROY_FILE: file, VAST_POLL_MS: '50' },
  }));
  try {
    const controller = new AbortController();
    const pending = client.callTool({ name: 'vast_create_instance', arguments: { offer_id: 1001, image: 'ubuntu' } }, undefined, { signal: controller.signal });
    await waitFor(() => slow.requests.some((r) => r.path === '/api/v0/asks/1001/'));
    controller.abort();
    await assert.rejects(pending);
    await waitFor(() => slow.history.length === 1 && slow.history[0].status === 'destroyed');
    await waitFor(() => fs.existsSync(file) && Object.keys(readJson(file)).length === 0);
  } finally {
    await client.close();
    await slow.close();
  }
});
