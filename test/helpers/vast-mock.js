// An in-memory stand-in for the Vast.ai API. Rented instances are real SSH servers
// (see ssh-server.js) that only accept keys attached through POST /instances/{id}/ssh/.

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { startSshServer } from './ssh-server.js';

export const DESKTOP_TEMPLATE = {
  id: 1,
  hash_id: '07fd4c405aef10347e8cac7b04453021',
  name: 'Linux Desktop Container',
  image: 'vastai/linux-desktop',
  tag: 'cuda-12.9-ubuntu24.04-2026-06-16',
  runtype: 'jupyter',
  use_ssh: true,
  recommended: true,
  recommended_disk_space: 32,
  creator_id: 525202,
  count_created: 100,
  desc: 'Ubuntu Linux Desktop Container',
  extra_filters: '{"compute_cap": {"gte": 750}, "gpu_display_active": {"eq": false}}',
};

const PYTORCH_TEMPLATE = { ...DESKTOP_TEMPLATE, id: 2, hash_id: 'aaaa', name: 'PyTorch (Vast)', image: 'vastai/pytorch', desc: 'PyTorch' };

export const OFFERS = [
  { id: 1001, ask_contract_id: 1001, num_gpus: 1, gpu_name: 'RTX 3060', gpu_ram: 12288, dph_total: 0.0756, cpu_cores_effective: 8, cpu_ram: 32000, disk_space: 100, inet_down: 600, inet_up: 500, reliability: 0.993, geolocation: 'South Korea, KR', cuda_max_good: 12.8, duration: 864000 },
  { id: 1002, ask_contract_id: 1002, num_gpus: 8, gpu_name: 'H100 SXM', gpu_ram: 81559, dph_total: 19.5, cpu_cores_effective: 128, cpu_ram: 1000000, disk_space: 2000, inet_down: 5000, inet_up: 5000, reliability: 0.999, geolocation: 'Texas, US', cuda_max_good: 13, duration: 864000 },
];

export async function startVastMock({
  apiKey = 'test-key',
  bootMs = 300,
  runtype = 'jupyter',
  // Commands sent to instances run here (a fresh temp dir by default, never the repo).
  instanceCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'vast-instance-')),
} = {}) {
  const instances = new Map();
  const history = [];
  const requests = [];
  let nextId = 5000;

  const json = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    let body = '';
    for await (const chunk of req) body += chunk;
    const data = body ? JSON.parse(body) : undefined;
    requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body: data });
    const authed = req.headers.authorization === `Bearer ${apiKey}`;
    const p = url.pathname;
    let m;

    if (p.startsWith('/logs/')) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('container started\nonstart done\n');
    }
    if (req.method === 'POST' && p === '/api/v0/bundles/') {
      let offers = OFFERS;
      if (data.ask_contract_id) offers = offers.filter((o) => o.id === data.ask_contract_id.eq);
      if (data.dph_total?.lte != null) offers = offers.filter((o) => o.dph_total <= data.dph_total.lte);
      return json(res, 200, { offers: offers.slice(0, data.limit || 10) });
    }
    if (req.method === 'GET' && p === '/api/v0/template/') {
      const filters = JSON.parse(url.searchParams.get('select_filters') || '{}');
      let templates = [DESKTOP_TEMPLATE, PYTORCH_TEMPLATE];
      if (filters.hash_id) templates = templates.filter((t) => t.hash_id === filters.hash_id.eq);
      return json(res, 200, { success: true, templates });
    }
    if (!authed) return json(res, 401, { success: false, error: 'auth_error', msg: 'This action requires login.' });

    if (req.method === 'GET' && p === '/api/v0/users/current/') {
      return json(res, 200, { id: 1, username: 'tester', email: 't@example.com', credit: 12.34, balance: 0 });
    }
    if (req.method === 'PUT' && (m = p.match(/^\/api\/v0\/asks\/(\d+)\/$/))) {
      const offer = OFFERS.find((o) => o.id === Number(m[1]));
      if (!offer) return json(res, 400, { success: false, error: 'invalid_args', msg: 'offer not found' });
      const id = nextId++;
      const inst = { id, offer, payload: data, keys: [], status: 'loading', intended: 'running', created: Date.now(), ssh: null };
      inst.ssh = await startSshServer({ authorizedKeys: () => inst.keys, cwd: instanceCwd });
      instances.set(id, inst);
      history.push(inst);
      setTimeout(() => {
        if (inst.status === 'loading') inst.status = 'running';
      }, bootMs);
      return json(res, 200, { success: true, new_contract: id });
    }
    if ((m = p.match(/^\/api\/v0\/instances\/(\d+)\/ssh\/$/)) && req.method === 'POST') {
      const inst = instances.get(Number(m[1]));
      if (!inst) return json(res, 404, { success: false, msg: 'no such instance' });
      inst.keys.push(data.ssh_key);
      return json(res, 200, { success: true });
    }
    if ((m = p.match(/^\/api\/v0\/instances\/request_logs\/(\d+)\/$/))) {
      return json(res, 200, { success: true, result_url: `http://127.0.0.1:${server.address().port}/logs/${m[1]}` });
    }
    if ((m = p.match(/^\/api\/v0\/instances\/(\d+)\/$/))) {
      const inst = instances.get(Number(m[1]));
      if (req.method === 'GET') return json(res, 200, { instances: inst ? view(inst) : null });
      if (!inst) return json(res, 404, { success: false, msg: 'no such instance' });
      if (req.method === 'DELETE') {
        inst.status = 'destroyed';
        instances.delete(inst.id);
        await inst.ssh.close();
        return json(res, 200, { success: true });
      }
      if (req.method === 'PUT' && data.state) {
        inst.intended = data.state;
        inst.status = data.state === 'stopped' ? 'exited' : 'running';
        return json(res, 200, { success: true });
      }
    }
    if (req.method === 'GET' && p === '/api/v1/instances/') {
      return json(res, 200, { instances: [...instances.values()].map(view), next_token: null });
    }
    json(res, 404, { success: false, msg: `mock: no route for ${req.method} ${p}` });
  });

  // Proxy SSH for jupyter images is ssh_port + 1, so report one less than the real port.
  const view = (inst) => ({
    id: inst.id,
    actual_status: inst.status,
    intended_status: inst.intended,
    status_msg: inst.status === 'loading' ? 'Pulling image vastai/linux-desktop' : 'success, running',
    num_gpus: inst.offer.num_gpus,
    gpu_name: inst.offer.gpu_name,
    dph_total: inst.offer.dph_total,
    image_uuid: inst.payload.image || 'vastai/linux-desktop',
    image_runtype: runtype,
    label: inst.payload.label,
    start_date: inst.created / 1000,
    ssh_host: '127.0.0.1',
    ssh_port: inst.ssh.port - (runtype.includes('jupyter') ? 1 : 0),
    public_ipaddr: inst.status === 'running' ? '127.0.0.1' : null,
    ports: {},
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    instances,
    history,
    requests,
    close: async () => {
      for (const inst of instances.values()) await inst.ssh.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
