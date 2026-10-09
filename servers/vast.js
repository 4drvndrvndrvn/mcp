#!/usr/bin/env node
// MCP server for renting and driving GPU machines on Vast.ai.
//
// Settings (from .env or the environment):
//   VAST_API_KEY              required for everything except searching offers/templates
//   VAST_MAX_PRICE_PER_HOUR   optional: refuse to rent offers that cost more than this ($/hr)
//   VAST_AUTO_DESTROY_MINUTES optional: destroy instances created here after this many minutes unless told otherwise
//   VAST_SSH_KEY_PATH         key used to reach instances (default: .data/vast_ed25519, created automatically)
//   VAST_API_URL              API base URL (default https://console.vast.ai)

import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ROOT_DIR, loadEnv, progressReporter, safe, sleep, text } from './lib/common.js';
import { SshPool, ensureKeyPair, formatExecResult } from './lib/ssh.js';
import {
  VastAPI,
  VAST_DEFAULT_URL,
  buildCreatePayload,
  formatInstance,
  formatOffer,
  formatTemplate,
  instanceStatus,
  sshEndpoints,
} from './lib/vast.js';

loadEnv();

const api = new VastAPI({ apiKey: process.env.VAST_API_KEY, baseUrl: process.env.VAST_API_URL || VAST_DEFAULT_URL });
const maxPrice = Number(process.env.VAST_MAX_PRICE_PER_HOUR) || null;
const keyPath = path.resolve(ROOT_DIR, process.env.VAST_SSH_KEY_PATH || '.data/vast_ed25519');
const pool = new SshPool();
const attached = new Set();
// Pooled SSH connections per instance, closed when the instance is stopped or destroyed.
const connectionsByInstance = new Map();
const POLL_MS = Number(process.env.VAST_POLL_MS) || 10_000;

// ---- Auto-destroy safety net ------------------------------------------------
// Deadlines are saved to disk so an instance whose deadline passed while the app was
// down is destroyed the next time this server starts.

const MAX_AUTO_DESTROY_MINUTES = 7 * 24 * 60; // setTimeout can't wait much longer than 24 days
const defaultAutoDestroy = Number(process.env.VAST_AUTO_DESTROY_MINUTES) || null;
const scheduleFile = path.resolve(ROOT_DIR, process.env.VAST_AUTO_DESTROY_FILE || '.data/vast-auto-destroy.json');
const autoDestroy = new Map(); // instance id -> { at, timer }

function saveSchedule() {
  try {
    fs.mkdirSync(path.dirname(scheduleFile), { recursive: true });
    const data = Object.fromEntries([...autoDestroy].map(([id, e]) => [id, e.at]));
    fs.writeFileSync(scheduleFile, `${JSON.stringify(data, null, 2)}\n`);
  } catch (err) {
    console.error(`[vast] could not save ${scheduleFile}: ${err.message}`);
  }
}

function cancelAutoDestroy(id) {
  const entry = autoDestroy.get(id);
  if (!entry) return;
  clearTimeout(entry.timer);
  autoDestroy.delete(id);
  saveSchedule();
}

function scheduleAutoDestroy(id, at) {
  clearTimeout(autoDestroy.get(id)?.timer);
  const timer = setTimeout(() => runAutoDestroy(id), Math.max(0, at - Date.now()));
  autoDestroy.set(id, { at, timer });
  saveSchedule();
}

async function runAutoDestroy(id) {
  try {
    await api.destroy(id);
    console.error(`[vast] auto-destroyed instance ${id}`);
    closeConnections(id);
    cancelAutoDestroy(id);
  } catch (err) {
    const stillThere = await api.getInstance(id).catch(() => true);
    if (!stillThere) return cancelAutoDestroy(id);
    console.error(`[vast] auto-destroy of instance ${id} failed, retrying in a minute: ${err.message}`);
    scheduleAutoDestroy(id, Date.now() + 60_000);
  }
}

if (api.apiKey) {
  try {
    for (const [id, at] of Object.entries(JSON.parse(fs.readFileSync(scheduleFile, 'utf8')))) scheduleAutoDestroy(Number(id), at);
  } catch {
    // No saved schedule.
  }
}

const describe = (inst) => {
  const entry = autoDestroy.get(inst.id);
  const minutes = entry ? Math.max(0, Math.round((entry.at - Date.now()) / 60_000)) : null;
  return formatInstance(inst) + (entry ? `\n  auto-destroy in ${minutes} min` : '');
};

let keyPair = null;
const sshKey = () => (keyPair ||= ensureKeyPair(keyPath, 'nanogpt-mcp-chat'));

/** Gives our SSH key access to the instance (once per instance per process). */
async function attachKey(id, signal) {
  if (attached.has(id)) return;
  try {
    await api.attachSshKey(id, sshKey().publicKey, { signal });
  } catch (err) {
    if (!/already/i.test(err.message)) throw err;
  }
  attached.add(id);
}

function closeConnections(id) {
  for (const key of connectionsByInstance.get(id) || []) pool.close(key);
  connectionsByInstance.delete(id);
}

const sshTarget = (endpoint) => ({ host: endpoint.host, port: endpoint.port, username: 'root', privateKey: sshKey().privateKey });

/** Runs a command on the first reachable SSH endpoint of an instance. */
async function execOnInstance(inst, command, { timeoutMs, signal, onProgress }) {
  const endpoints = sshEndpoints(inst);
  if (!endpoints.length) throw new Error(`Instance ${inst.id} has no SSH address yet. Call vast_wait_for_instance first.`);
  const errors = [];
  for (const endpoint of endpoints) {
    try {
      // Instances are short-lived and reuse host:port pairs, so known_hosts can't be trusted for them.
      const target = sshTarget(endpoint);
      const result = await pool.exec(target, command, { timeoutMs, signal, onProgress, hostKeys: { mode: 'off' } });
      if (!connectionsByInstance.has(inst.id)) connectionsByInstance.set(inst.id, new Set());
      connectionsByInstance.get(inst.id).add(pool.keyFor(target));
      return { endpoint, result };
    } catch (err) {
      if (signal?.aborted) throw err;
      errors.push(`${endpoint.kind} ${endpoint.host}:${endpoint.port}: ${err.message}`);
    }
  }
  const hint = errors.some((e) => /authentication/i.test(e))
    ? ' The SSH key may still be propagating; call vast_wait_for_instance and try again.'
    : '';
  throw new Error(`Could not reach instance ${inst.id} over SSH.${hint}\n${errors.join('\n')}`);
}

async function requireInstance(id, signal) {
  const inst = await api.getInstance(id, { signal });
  if (!inst) throw new Error(`Instance ${id} was not found (it may have been destroyed).`);
  return inst;
}

const instanceId = z.number().int().positive().describe('Instance id (from vast_create_instance or vast_list_instances)');

const server = new McpServer({ name: 'vast', version: '1.0.0' });

server.registerTool(
  'vast_account',
  {
    title: 'Vast.ai account',
    description: 'Show the Vast.ai account and its remaining credit.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  safe(async (_, extra) => {
    const u = await api.account({ signal: extra.signal });
    const money = (v) => (typeof v === 'number' ? `$${v.toFixed(2)}` : '?');
    return text(
      [`Account: ${u.username || u.email || u.id}`, `Credit: ${money(u.credit)}`, `Balance: ${money(u.balance)}`]
        .concat(maxPrice ? [`Price limit for new rentals: $${maxPrice}/hr`] : [])
        .join('\n'),
    );
  }),
);

server.registerTool(
  'vast_search_templates',
  {
    title: 'Search Vast.ai templates',
    description:
      'Find Vast.ai templates: ready-made images and launch settings, e.g. "desktop" for a Linux desktop you can open in the browser, ' +
      '"pytorch", "comfyui" or "ollama". Pass the hash to vast_search_offers and vast_create_instance.',
    inputSchema: {
      query: z.string().optional().describe('Words to match in the name, image or description, e.g. "desktop"'),
      include_community: z.boolean().optional().describe('Also search unreviewed community templates (default: only Vast.ai recommended ones)'),
      limit: z.number().int().min(1).max(30).optional().describe('Max results (default 8)'),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  safe(async ({ query = '', include_community = false, limit = 8 }, extra) => {
    const all = await api.searchTemplates(include_community ? {} : { recommended: { eq: true } }, { signal: extra.signal });
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const seen = new Set();
    const matches = all
      .filter((t) => {
        const hay = `${t.name} ${t.image} ${t.desc || ''}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      })
      .sort((a, b) => Number(Boolean(b.recommended)) - Number(Boolean(a.recommended)) || (b.count_created || 0) - (a.count_created || 0))
      .filter((t) => {
        const key = `${t.name}|${t.image}|${t.tag}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, limit);
    if (!matches.length) {
      return text(`No templates matched "${query}".${include_community ? '' : ' Try include_community: true, or a different word.'}`);
    }
    return text(`${matches.map(formatTemplate).join('\n\n')}\n\nUse a template's hash as template_hash in vast_search_offers and vast_create_instance.`);
  }),
);

const ORDER = {
  price: [['dph_total', 'asc']],
  value: [['dlperf_per_dphtotal', 'desc']],
  performance: [['dlperf', 'desc']],
  reliability: [['reliability', 'desc']],
  score: [['score', 'desc']],
};

server.registerTool(
  'vast_search_offers',
  {
    title: 'Search Vast.ai GPU offers',
    description:
      'Search machines available to rent on Vast.ai. Pass template_hash to only get machines compatible with that template. ' +
      'Prices are per hour and include the requested disk.',
    inputSchema: {
      template_hash: z.string().optional().describe('Only show machines that can run this template (from vast_search_templates)'),
      gpu_name: z.string().optional().describe('Exact GPU model, e.g. "RTX 4090", "RTX 3090", "A100 SXM4", "H100 SXM"'),
      num_gpus: z.number().int().min(1).max(64).optional().describe('Exact number of GPUs'),
      min_gpu_ram_gb: z.number().min(0).optional().describe('Minimum VRAM per GPU in GB'),
      max_price_per_hour: z.number().min(0).optional().describe('Maximum total $/hr'),
      min_reliability: z.number().min(0).max(1).optional().describe('Minimum host reliability, 0-1 (e.g. 0.98)'),
      min_disk_gb: z.number().min(0).optional().describe('Minimum free disk on the machine in GB'),
      min_cuda: z.number().min(0).optional().describe('Minimum supported CUDA version, e.g. 12.4'),
      countries: z.array(z.string()).optional().describe('Two-letter country codes, e.g. ["US", "CA"]'),
      type: z.enum(['on-demand', 'interruptible']).optional().describe('on-demand (default) or cheaper interruptible (bid) instances'),
      order_by: z.enum(['price', 'value', 'performance', 'reliability', 'score']).optional().describe('Sort order (default price)'),
      disk_gb: z.number().min(1).optional().describe('Disk you plan to rent, used for pricing (default: template recommendation or 20)'),
      limit: z.number().int().min(1).max(50).optional().describe('Max results (default 10)'),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  safe(async (args, extra) => {
    const q = { verified: { eq: true }, external: { eq: false }, rentable: { eq: true }, rented: { eq: false } };
    let template = null;
    if (args.template_hash) {
      template = await api.getTemplate(args.template_hash, { signal: extra.signal });
      if (!template) throw new Error(`No template with hash ${args.template_hash}. Use vast_search_templates to find one.`);
      try {
        Object.assign(q, JSON.parse(template.extra_filters || '{}'));
      } catch {
        // Ignore malformed template filters.
      }
    }
    if (args.gpu_name) q.gpu_name = { eq: args.gpu_name.replace(/_/g, ' ') };
    if (args.num_gpus) q.num_gpus = { eq: args.num_gpus };
    if (args.min_gpu_ram_gb != null) q.gpu_ram = { gte: args.min_gpu_ram_gb * 1000 };
    if (args.max_price_per_hour != null) q.dph_total = { lte: args.max_price_per_hour };
    if (args.min_reliability != null) q.reliability = { gte: args.min_reliability };
    if (args.min_disk_gb != null) q.disk_space = { gte: args.min_disk_gb };
    if (args.min_cuda != null) q.cuda_max_good = { gte: args.min_cuda };
    if (args.countries?.length) q.geolocation = { in: args.countries.map((c) => c.toUpperCase()) };
    const disk = args.disk_gb ?? template?.recommended_disk_space ?? 20;
    q.order = ORDER[args.order_by || 'price'];
    q.type = args.type === 'interruptible' ? 'bid' : 'on-demand';
    q.limit = args.limit || 10;
    q.allocated_storage = disk;

    const offers = await api.searchOffers(q, { signal: extra.signal });
    if (!offers.length) return text('No offers matched. Loosen the filters (price, GPU, reliability, countries) and try again.');
    const header = `${offers.length} offers${template ? ` compatible with "${template.name}"` : ''} (prices include ${disk} GB disk):`;
    const footer = maxPrice ? `\nNote: renting is limited to $${maxPrice}/hr (VAST_MAX_PRICE_PER_HOUR).` : '';
    return text(`${header}\n${offers.map(formatOffer).join('\n')}${footer}\n\nRent one with vast_create_instance(offer_id, ...).`);
  }),
);

server.registerTool(
  'vast_create_instance',
  {
    title: 'Rent a Vast.ai instance',
    description:
      'Rent a machine from an offer (see vast_search_offers). Billing starts now and continues until vast_destroy_instance. ' +
      'Use template_hash (from vast_search_templates) or a Docker image. An SSH key is attached automatically so vast_exec works.',
    inputSchema: {
      offer_id: z.number().int().positive().describe('Offer id from vast_search_offers'),
      template_hash: z.string().optional().describe('Template to launch (recommended), from vast_search_templates'),
      image: z.string().optional().describe('Docker image to run when not using a template, e.g. "vastai/base-image:@vastai-automatic-tag"'),
      disk_gb: z.number().min(1).max(4000).optional().describe('Disk size in GB (default: template recommendation or 20)'),
      label: z.string().optional().describe('A label to recognize the instance'),
      onstart: z.string().optional().describe('Shell script to run at startup (only without a template; with a template use vast_exec instead)'),
      env: z.record(z.string(), z.string()).optional().describe('Environment variables for the container'),
      ports: z.array(z.number().int().min(1).max(65535)).optional().describe('Extra container ports to expose'),
      bid_price: z.number().positive().optional().describe('For an interruptible instance: your bid in $/hr'),
      auto_destroy_minutes: z
        .number()
        .positive()
        .max(MAX_AUTO_DESTROY_MINUTES)
        .optional()
        .describe(
          'Safety net: destroy the instance automatically after this many minutes, even if vast_destroy_instance is never called. ' +
            `Good for short tasks.${defaultAutoDestroy ? ` Default: ${defaultAutoDestroy}.` : ''}`,
        ),
    },
    annotations: { destructiveHint: false, openWorldHint: true },
  },
  safe(async (args, extra) => {
    const { offer_id, template_hash, image, label, onstart, bid_price } = args;
    if (!template_hash && !image) throw new Error('Pass template_hash (see vast_search_templates) or image.');
    let template = null;
    if (template_hash) {
      template = await api.getTemplate(template_hash, { signal: extra.signal });
      if (!template) throw new Error(`No template with hash ${template_hash}. Use vast_search_templates to find one.`);
    }
    const disk = args.disk_gb ?? template?.recommended_disk_space ?? 20;

    const offer = await api
      .getOffer(offer_id, { disk, type: bid_price != null ? 'bid' : 'on-demand', signal: extra.signal })
      .catch(() => null);
    const hourly = bid_price ?? offer?.dph_total;
    if (maxPrice && hourly == null) {
      throw new Error(`Could not look up the price of offer ${offer_id}, so VAST_MAX_PRICE_PER_HOUR can't be checked. Search again and pick a current offer.`);
    }
    if (maxPrice && hourly > maxPrice) {
      throw new Error(`Offer ${offer_id} costs $${hourly.toFixed(3)}/hr, above VAST_MAX_PRICE_PER_HOUR ($${maxPrice}/hr).`);
    }

    const notes = [];
    // A template's own startup script (e.g. the desktop's entrypoint.sh) must not be replaced.
    const startup = template ? null : onstart;
    if (template && onstart) notes.push('onstart was ignored because the template has its own startup script; run your commands with vast_exec once the instance is ready.');

    const env = { ...(args.env || {}) };
    for (const p of args.ports || []) env[`-p ${p}:${p}`] = '1';
    const payload = buildCreatePayload({
      image: template ? null : image,
      templateHash: template_hash,
      disk,
      env,
      label,
      onstart: startup,
      runtype: template ? undefined : 'ssh_direc ssh_proxy',
      price: bid_price,
    });
    const res = await api.createInstance(offer_id, payload, { signal: extra.signal });
    const id = res.new_contract;
    if (!id) throw new Error(`Vast.ai did not return an instance id: ${JSON.stringify(res)}`);

    const minutes = args.auto_destroy_minutes ?? defaultAutoDestroy;
    if (minutes) {
      scheduleAutoDestroy(id, Date.now() + minutes * 60_000);
      notes.push(`It will be destroyed automatically in ${minutes} minutes (change with vast_set_auto_destroy).`);
    }
    try {
      await attachKey(id, extra.signal);
    } catch (err) {
      notes.push(`The SSH key could not be attached yet (${err.message}); vast_wait_for_instance will retry.`);
    }
    const what = template ? `template "${template.name}"` : `image ${image}`;
    const machine = offer ? ` (${offer.num_gpus}x ${offer.gpu_name}, ~$${offer.dph_total.toFixed(3)}/hr)` : '';
    return text(
      `Created instance ${id} from offer ${offer_id}${machine} with ${what} and ${disk} GB disk. ` +
        `It is billed until you call vast_destroy_instance.\n` +
        `Next: call vast_wait_for_instance with instance_id ${id}; large images can take several minutes to download.` +
        notes.map((n) => `\n${n}`).join(''),
    );
  }),
);

server.registerTool(
  'vast_list_instances',
  {
    title: 'List Vast.ai instances',
    description: 'List your Vast.ai instances with their status, price and SSH address.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  safe(async (_, extra) => {
    const rows = await api.listInstances({ signal: extra.signal });
    if (!rows.length) return text('You have no Vast.ai instances.');
    const hourly = rows.reduce((sum, i) => sum + (i.actual_status === 'running' ? i.dph_total || 0 : 0), 0);
    return text(`${rows.map(describe).join('\n\n')}\n\nRunning cost: $${hourly.toFixed(3)}/hr`);
  }),
);

server.registerTool(
  'vast_get_instance',
  {
    title: 'Get a Vast.ai instance',
    description: "Show one instance's status, price and SSH address.",
    inputSchema: { instance_id: instanceId },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  safe(async ({ instance_id }, extra) => text(describe(await requireInstance(instance_id, extra.signal)))),
);

server.registerTool(
  'vast_wait_for_instance',
  {
    title: 'Wait for a Vast.ai instance',
    description:
      'Wait until an instance is running and (by default) reachable over SSH, so vast_exec will work. ' +
      'Reports progress while the image downloads.',
    inputSchema: {
      instance_id: instanceId,
      timeout_seconds: z.number().int().min(10).max(3600).optional().describe('Give up after this long (default 900)'),
      check_ssh: z.boolean().optional().describe('Also wait until SSH login works (default true)'),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  safe(async ({ instance_id, timeout_seconds = 900, check_ssh = true }, extra) => {
    const report = progressReporter(extra);
    const started = Date.now();
    const deadline = started + timeout_seconds * 1000;
    let lastProblem = '';
    while (true) {
      const elapsed = Math.round((Date.now() - started) / 1000);
      const inst = await api.getInstance(instance_id, { signal: extra.signal });
      if (!inst) {
        // A just-created instance can take a moment to show up.
        if (elapsed > 60) throw new Error(`Instance ${instance_id} was not found (it may have been destroyed).`);
        report(`waiting for instance ${instance_id} to appear (${elapsed}s)`);
        await sleep(POLL_MS, extra.signal);
        continue;
      }
      const status = instanceStatus(inst);
      report(`${status}${inst.status_msg ? `: ${String(inst.status_msg).trim().slice(0, 100)}` : ''} (${elapsed}s)`);

      if (inst.intended_status === 'stopped' && status !== 'running') {
        return text(`Instance ${instance_id} is stopped. Start it with vast_start_instance.\n${describe(inst)}`, true);
      }
      if (status === 'running') {
        if (!check_ssh) return text(`Instance ${instance_id} is running.\n${describe(inst)}`);
        try {
          await attachKey(instance_id, extra.signal);
          const { endpoint, result } = await execOnInstance(inst, 'echo ready', { timeoutMs: 20_000, signal: extra.signal });
          if (result.code === 0) {
            return text(`Instance ${instance_id} is running and reachable over SSH (${endpoint.kind}). Use vast_exec to run commands.\n${describe(inst)}`);
          }
          lastProblem = `SSH test exited with ${result.code}: ${result.stderr.trim()}`;
        } catch (err) {
          if (extra.signal?.aborted) throw err;
          lastProblem = err.message.split('\n')[0];
        }
        report(`running, waiting for SSH: ${lastProblem.slice(0, 100)}`);
      }
      if (Date.now() >= deadline) {
        return text(
          `Instance ${instance_id} was not ready after ${timeout_seconds}s.${lastProblem ? ` Last problem: ${lastProblem}` : ''}\n${describe(inst)}\n` +
            'You can wait longer, check vast_instance_logs, or destroy it.',
          true,
        );
      }
      await sleep(POLL_MS, extra.signal);
    }
  }),
);

server.registerTool(
  'vast_exec',
  {
    title: 'Run a command on a Vast.ai instance',
    description:
      'Run a shell command (as root) on a running instance over SSH and return its output, e.g. to download or install software. ' +
      'Call vast_wait_for_instance first. For long jobs raise timeout_seconds or use nohup ... &.',
    inputSchema: {
      instance_id: instanceId,
      command: z.string().describe('Shell command to run'),
      timeout_seconds: z.number().int().min(1).max(3600).optional().describe('Stop the command after this long (default 300)'),
    },
    annotations: { destructiveHint: true, openWorldHint: true },
  },
  safe(async ({ instance_id, command, timeout_seconds = 300 }, extra) => {
    const inst = await requireInstance(instance_id, extra.signal);
    if (instanceStatus(inst) !== 'running') {
      return text(`Instance ${instance_id} is ${instanceStatus(inst)}, not running. Call vast_wait_for_instance first.`, true);
    }
    await attachKey(instance_id, extra.signal);
    const timeoutMs = timeout_seconds * 1000;
    const { endpoint, result } = await execOnInstance(inst, command, {
      timeoutMs,
      signal: extra.signal,
      onProgress: progressReporter(extra),
    });
    return text(formatExecResult(`instance ${instance_id} via ${endpoint.kind} ssh`, command, result, timeoutMs), result.timedOut);
  }),
);

server.registerTool(
  'vast_instance_logs',
  {
    title: 'Vast.ai instance logs',
    description: "Fetch the last lines of an instance's container log (startup, onstart script and image download output).",
    inputSchema: {
      instance_id: instanceId,
      tail: z.number().int().min(1).max(5000).optional().describe('Number of lines (default 200)'),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  safe(async ({ instance_id, tail = 200 }, extra) => {
    const logs = await api.logs(instance_id, { tail, signal: extra.signal });
    const cleaned = String(logs).trim();
    return text(cleaned ? cleaned.slice(-30_000) : '(the log is empty)');
  }),
);

server.registerTool(
  'vast_set_auto_destroy',
  {
    title: 'Set auto-destroy time',
    description: 'Set or cancel the automatic destroy deadline of an instance.',
    inputSchema: {
      instance_id: instanceId,
      minutes: z.number().min(0).max(MAX_AUTO_DESTROY_MINUTES).describe('Destroy it this many minutes from now; 0 cancels auto-destroy'),
    },
    annotations: { destructiveHint: true, openWorldHint: true },
  },
  safe(async ({ instance_id, minutes }, extra) => {
    await requireInstance(instance_id, extra.signal);
    if (!minutes) {
      cancelAutoDestroy(instance_id);
      return text(`Auto-destroy cancelled for instance ${instance_id}. It keeps running (and billing) until destroyed.`);
    }
    scheduleAutoDestroy(instance_id, Date.now() + minutes * 60_000);
    return text(`Instance ${instance_id} will be destroyed automatically in ${minutes} minutes.`);
  }),
);

const stateTool = (name, title, description, action, done) =>
  server.registerTool(
    name,
    {
      title,
      description,
      inputSchema: { instance_id: instanceId },
      annotations: { destructiveHint: name === 'vast_destroy_instance', openWorldHint: true },
    },
    safe(async ({ instance_id }, extra) => {
      await action(instance_id, { signal: extra.signal });
      if (name === 'vast_destroy_instance' || name === 'vast_stop_instance') closeConnections(instance_id);
      if (name === 'vast_destroy_instance') {
        attached.delete(instance_id);
        cancelAutoDestroy(instance_id);
      }
      return text(done(instance_id));
    }),
  );

stateTool(
  'vast_start_instance',
  'Start a Vast.ai instance',
  'Start a stopped instance (it may fail if the machine has been rented out meanwhile).',
  (id, o) => api.setState(id, 'running', o),
  (id) => `Starting instance ${id}. Use vast_wait_for_instance to know when it is ready.`,
);
stateTool(
  'vast_stop_instance',
  'Stop a Vast.ai instance',
  'Stop an instance. GPU billing stops, but storage is still billed and the data is kept until it is destroyed.',
  (id, o) => api.setState(id, 'stopped', o),
  (id) => `Stopping instance ${id}. Storage is still billed until it is destroyed.`,
);
stateTool(
  'vast_reboot_instance',
  'Reboot a Vast.ai instance',
  'Restart the container of an instance, keeping its data.',
  (id, o) => api.reboot(id, o),
  (id) => `Rebooting instance ${id}.`,
);
stateTool(
  'vast_destroy_instance',
  'Destroy a Vast.ai instance',
  'Permanently delete an instance and all of its data. Billing stops. This cannot be undone.',
  (id, o) => api.destroy(id, o),
  (id) => `Destroyed instance ${id}. Billing for it has stopped.`,
);

process.on('SIGTERM', () => {
  pool.closeAll();
  process.exit(0);
});

await server.connect(new StdioServerTransport());
