// Small client for the Vast.ai REST API (https://console.vast.ai/api/v0), following
// the endpoints used by the official `vastai` CLI.

import { sleep } from './common.js';

export const VAST_DEFAULT_URL = 'https://console.vast.ai';
const KEY_HELP =
  'VAST_API_KEY is not set. Create a key at https://cloud.vast.ai/manage-keys/, add VAST_API_KEY=... to .env, then reconnect the "vast" MCP server.';

export class VastAPI {
  constructor({ apiKey, baseUrl = VAST_DEFAULT_URL, fetchImpl = globalThis.fetch } = {}) {
    this.apiKey = apiKey || '';
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.fetch = fetchImpl;
  }

  url(path, query) {
    const full = /^\/api\/v\d+\//.test(path) ? path : `/api/v0${path}`;
    const qs = Object.entries(query || {})
      .map(([k, v]) => `${k}=${encodeURIComponent(typeof v === 'string' ? v : JSON.stringify(v))}`)
      .join('&');
    return `${this.baseUrl}${full}${qs ? `?${qs}` : ''}`;
  }

  async request(method, path, { query, body, auth = true, signal } = {}) {
    if (auth && !this.apiKey) throw new Error(KEY_HELP);
    const headers = { Accept: 'application/json', 'User-Agent': 'nanogpt-mcp-chat' };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await this.fetch(this.url(path, query), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    const raw = await res.text();
    let json = null;
    try {
      json = raw ? JSON.parse(raw) : {};
    } catch {
      // Non-JSON error page.
    }
    if (!res.ok || json?.success === false) {
      const msg = json?.msg || json?.error_description || json?.error || raw.slice(0, 300) || res.statusText;
      if (res.status === 401 || res.status === 403) {
        throw new Error(`Vast.ai rejected the request (${res.status}): ${msg}. Check VAST_API_KEY.`);
      }
      throw new Error(`Vast.ai ${res.status}: ${msg}`);
    }
    return json ?? {};
  }

  account(opts) {
    return this.request('GET', '/users/current/', opts);
  }

  async searchOffers(query, opts) {
    return (await this.request('POST', '/bundles/', { ...opts, body: query, auth: false })).offers || [];
  }

  /** Looks up one offer by id (null if it no longer exists). */
  async getOffer(id, { disk = 10, type = 'on-demand', ...opts } = {}) {
    const offers = await this.searchOffers({ ask_contract_id: { eq: Number(id) }, type, limit: 1, allocated_storage: disk }, opts);
    return offers[0] || null;
  }

  async searchTemplates(selectFilters = {}, opts) {
    const json = await this.request('GET', '/template/', {
      ...opts,
      auth: false,
      query: { select_cols: ['*'], select_filters: selectFilters },
    });
    return json.templates || [];
  }

  async getTemplate(hash, opts) {
    return (await this.searchTemplates({ hash_id: { eq: hash } }, opts))[0] || null;
  }

  async listInstances(opts) {
    const rows = [];
    const params = { select_filters: {}, order_by: [{ col: 'id', dir: 'asc' }], limit: 25 };
    for (let page = 0; page < 40; page++) {
      const json = await this.request('GET', '/api/v1/instances/', { ...opts, query: params });
      rows.push(...(json.instances || []));
      if (!json.next_token) break;
      params.after_token = json.next_token;
    }
    return rows;
  }

  async getInstance(id, opts) {
    return (await this.request('GET', `/instances/${id}/`, { ...opts, query: { owner: 'me' } })).instances || null;
  }

  createInstance(offerId, payload, opts) {
    return this.request('PUT', `/asks/${offerId}/`, { ...opts, body: payload });
  }

  setState(id, state, opts) {
    return this.request('PUT', `/instances/${id}/`, { ...opts, body: { state } });
  }

  reboot(id, opts) {
    return this.request('PUT', `/instances/reboot/${id}/`, { ...opts, body: {} });
  }

  destroy(id, opts) {
    return this.request('DELETE', `/instances/${id}/`, { ...opts, body: {} });
  }

  attachSshKey(id, sshKey, opts) {
    return this.request('POST', `/instances/${id}/ssh/`, { ...opts, body: { ssh_key: sshKey } });
  }

  /** Requests an instance's container logs and waits for them to be uploaded. */
  async logs(id, { tail = 200, signal } = {}) {
    const json = await this.request('PUT', `/instances/request_logs/${id}/`, { body: { tail: String(tail) }, signal });
    if (!json.result_url) return json.result || JSON.stringify(json);
    for (let i = 0; i < 30; i++) {
      await sleep(1000, signal);
      const res = await this.fetch(json.result_url, { signal });
      if (res.ok) return res.text();
    }
    throw new Error('Timed out waiting for Vast.ai to upload the logs. Try again in a moment.');
  }
}

// ---- Formatting -------------------------------------------------------------

const num = (v, digits = 0) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits) : '?');
const gb = (mb) => (typeof mb === 'number' ? (mb / 1000).toFixed(0) : '?');

export function formatOffer(o) {
  return [
    `offer ${o.id}: ${o.num_gpus}x ${o.gpu_name} (${gb(o.gpu_ram)} GB VRAM)`,
    `$${num(o.dph_total, 3)}/hr`,
    `${num(o.cpu_cores_effective)} vCPU, ${gb(o.cpu_ram)} GB RAM, ${num(o.disk_space)} GB disk`,
    `net ${num(o.inet_down)}↓/${num(o.inet_up)}↑ Mbps`,
    `reliability ${num((o.reliability2 ?? o.reliability) * 100, 1)}%`,
    o.geolocation || 'unknown location',
    `CUDA ${o.cuda_max_good ?? '?'}`,
    `max ${num((o.duration || 0) / 86400)} days`,
  ].join(' | ');
}

export function formatTemplate(t) {
  const lines = [
    `template "${t.name}" — hash ${t.hash_id}`,
    `  image: ${t.image}${t.tag ? `:${t.tag}` : ''} | launch mode: ${t.runtype}${t.use_ssh ? ' + ssh' : ''} | recommended disk: ${t.recommended_disk_space ?? '?'} GB`,
  ];
  if (t.desc) lines.push(`  ${String(t.desc).trim().slice(0, 200)}`);
  if (!t.recommended) {
    lines.push(`  community template by user ${t.creator_id} (not reviewed by Vast.ai)`);
    if (t.onstart) lines.push(`  onstart: ${String(t.onstart).slice(0, 300)}`);
  }
  return lines.join('\n');
}

/** SSH endpoints for an instance, preferring a direct connection over Vast's proxy. */
export function sshEndpoints(inst) {
  const out = [];
  const direct = inst.ports?.['22/tcp']?.[0]?.HostPort;
  if (direct && inst.public_ipaddr) out.push({ host: inst.public_ipaddr.trim(), port: Number(direct), kind: 'direct' });
  if (inst.ssh_host && inst.ssh_port) {
    // Jupyter-mode images run their own sshd one port above the proxy port.
    const port = Number(inst.ssh_port) + (String(inst.image_runtype || '').includes('jupyter') ? 1 : 0);
    out.push({ host: String(inst.ssh_host).trim(), port, kind: 'proxy' });
  }
  return out;
}

export function instanceStatus(inst) {
  return inst.actual_status || inst.cur_state || 'scheduling';
}

export function formatInstance(inst) {
  const lines = [
    `instance ${inst.id}${inst.label ? ` "${inst.label}"` : ''}: ${instanceStatus(inst)}` +
      (inst.intended_status && inst.intended_status !== inst.actual_status ? ` (target: ${inst.intended_status})` : ''),
    `  ${inst.num_gpus ?? '?'}x ${inst.gpu_name ?? '?'} | $${num(inst.dph_total, 3)}/hr | image ${inst.image_uuid ?? '?'}`,
  ];
  if (inst.status_msg) lines.push(`  status: ${String(inst.status_msg).trim().slice(0, 300)}`);
  const endpoints = sshEndpoints(inst);
  if (endpoints.length) {
    lines.push(`  ssh: ${endpoints.map((e) => `ssh -p ${e.port} root@${e.host} (${e.kind})`).join(' or ')}`);
  }
  if (inst.start_date) lines.push(`  age: ${num((Date.now() / 1000 - inst.start_date) / 60)} min`);
  return lines.join('\n');
}

/** Builds the PUT /asks/{id}/ body the same way the vastai CLI does. */
export function buildCreatePayload({ image, templateHash, disk, env, label, onstart, runtype, price }) {
  const payload = {
    client_id: 'me',
    image: image || null,
    env: env || {},
    price: price ?? null,
    disk,
    label: label || null,
    extra: null,
    onstart: onstart || null,
    image_login: null,
    python_utf8: false,
    lang_utf8: false,
    use_jupyter_lab: false,
    jupyter_dir: null,
    force: false,
    cancel_unavail: false,
    template_hash_id: templateHash || null,
    user: null,
  };
  if (runtype) payload.runtype = runtype;
  return payload;
}
