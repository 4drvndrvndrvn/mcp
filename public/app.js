/* global marked, DOMPurify */

// ---------- Helpers ----------

const $ = (sel, root = document) => root.querySelector(sel);

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key === 'class') node.className = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...children.flat().filter((c) => c != null && c !== false));
  return node;
}

const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(`nanochat.${key}`);
      return raw == null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`nanochat.${key}`, JSON.stringify(value));
    } catch {
      // Storage full or unavailable; the app still works for this session.
    }
  },
};

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

function formatCost(cost) {
  if (cost == null) return '';
  if (cost === 0) return '$0';
  return cost < 0.01 ? `$${cost.toFixed(5)}` : `$${cost.toFixed(4)}`;
}

const formatPrice = (p) => (typeof p === 'number' ? `$${+p.toFixed(3)}` : '?');

function prettyJson(text) {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function splitToolName(name, server, tool) {
  if (server && tool) return { server, tool };
  const i = name.indexOf('__');
  return i > 0 ? { server: name.slice(0, i), tool: name.slice(i + 2) } : { server: '', tool: name };
}

// ---------- Markdown ----------

marked.use({ gfm: true, breaks: true });
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

function renderMarkdown(target, text) {
  target.innerHTML = DOMPurify.sanitize(marked.parse(text));
  for (const pre of target.querySelectorAll('pre')) {
    const button = el('button', { class: 'copy-code', type: 'button' }, 'Copy');
    button.addEventListener('click', () => {
      navigator.clipboard?.writeText(pre.querySelector('code')?.textContent ?? '');
      button.textContent = 'Copied';
      setTimeout(() => (button.textContent = 'Copy'), 1200);
    });
    pre.append(button);
  }
}

// ---------- State ----------

const state = {
  config: {},
  models: [],
  model: store.get('model', null),
  toolsOnly: store.get('toolsOnly', false),
  useTools: store.get('useTools', true),
  confirmTools: store.get('confirmTools', true),
  settings: store.get('settings', { system: '', temperature: null }),
  token: store.get('token', ''),
  conversations: store.get('conversations', []),
  currentId: store.get('currentId', null),
  servers: [],
  abort: null,
};

const messagesEl = $('#messages');
const input = $('#input');

const current = () => state.conversations.find((c) => c.id === state.currentId) || null;

function saveConversations() {
  store.set('conversations', state.conversations);
  store.set('currentId', state.currentId);
}

// ---------- API ----------

async function api(path, { method = 'GET', body, signal } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const res = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  if (res.status === 401) {
    openSettings({ focusToken: true });
    throw new Error('An access token is required. Enter it in Settings.');
  }
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      message = (await res.json()).error || message;
    } catch {
      // Keep the status text.
    }
    throw new Error(message);
  }
  return res;
}

async function* readEvents(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const data = block
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (data) yield JSON.parse(data);
    }
  }
}

// ---------- Rendering: one assistant turn ----------

class TurnView {
  constructor(container, { live = false } = {}) {
    this.root = el('div', { class: 'msg assistant' });
    this.tail = live ? el('span', { class: 'cursor' }) : null;
    if (this.tail) this.root.append(this.tail);
    container.append(this.root);
    this.text = null;
    this.reasoning = null;
    this.cards = new Map();
  }

  add(node) {
    this.root.insertBefore(node, this.tail);
    return node;
  }

  reasoningDelta(content) {
    if (!this.reasoning) {
      const body = el('div', { class: 'reasoning-body' });
      const summary = el('summary', {}, this.tail ? 'Thinking…' : 'Thought process');
      this.reasoning = { summary, body, text: '' };
      this.add(el('details', { class: 'reasoning' }, summary, body));
    }
    this.reasoning.text += content;
    this.reasoning.body.textContent = this.reasoning.text;
    scrollIfPinned();
  }

  delta(content) {
    if (!this.text) this.text = { node: this.add(el('div', { class: 'md' })), buffer: '' };
    this.text.buffer += content;
    if (!this.tail) return this.flush();
    if (!this.frame) {
      this.frame = requestAnimationFrame(() => {
        this.frame = null;
        this.flush();
      });
    }
  }

  flush() {
    if (this.text) renderMarkdown(this.text.node, this.text.buffer);
    scrollIfPinned();
  }

  endSegment() {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.flush();
    if (this.reasoning) this.reasoning.summary.textContent = 'Thought process';
    this.text = null;
    this.reasoning = null;
  }

  toolCall({ id, name, server, tool, arguments: args, needsApproval }, onDecide) {
    const parts = splitToolName(name, server, tool);
    const status = el('span', { class: 'tool-state running' }, el('span', { class: 'spinner' }));
    const result = el('pre', {}, 'Running…');
    let approval = null;
    if (needsApproval && onDecide) {
      status.className = 'tool-state running awaiting';
      status.textContent = 'needs your approval';
      result.textContent = 'Waiting for approval…';
      const decide = async (approved) => {
        for (const b of approval.querySelectorAll('button')) b.disabled = true;
        try {
          await onDecide(approved);
          approval.remove();
          if (approved) this.toolProgress({ id, message: 'running…' });
          else status.textContent = 'denied';
        } catch (err) {
          for (const b of approval.querySelectorAll('button')) b.disabled = false;
          alert(err.message);
        }
      };
      approval = el(
        'div',
        { class: 'approval' },
        el('span', {}, 'Run this tool?'),
        el('button', { class: 'btn small primary', type: 'button', onclick: () => decide(true) }, 'Run'),
        el('button', { class: 'btn small danger', type: 'button', onclick: () => decide(false) }, 'Deny'),
      );
    }
    const card = el(
      'details',
      { class: 'tool', open: Boolean(approval) },
      el(
        'summary',
        {},
        el('span', { class: 'tool-icon' }, '⚙'),
        el('span', { class: 'tool-name' }, parts.tool),
        parts.server ? el('span', { class: 'tool-server' }, `· ${parts.server}`) : null,
        status,
      ),
      el(
        'div',
        { class: 'tool-body' },
        el('div', { class: 'label' }, 'Arguments'),
        el('pre', {}, prettyJson(args || '{}')),
        approval,
        el('div', { class: 'label' }, 'Result'),
        result,
      ),
    );
    this.cards.set(id, { status, result, card });
    this.add(card);
    scrollIfPinned();
  }

  toolProgress({ id, message }) {
    const card = this.cards.get(id);
    if (!card || !card.status.classList.contains('running')) return;
    card.status.className = 'tool-state running';
    card.status.replaceChildren(el('span', { class: 'spinner' }), message ? ` ${message}` : '');
  }

  toolResult({ id, content, isError }) {
    const card = this.cards.get(id);
    if (!card) return;
    card.card.querySelector('.approval')?.remove();
    card.result.textContent = content || '(no output)';
    card.status.className = `tool-state ${isError ? 'err' : 'ok'}`;
    card.status.textContent = isError ? '✕ error' : '✓ done';
  }

  notice(message) {
    this.add(el('div', { class: 'notice' }, message));
    scrollIfPinned();
  }

  error(message, onRetry) {
    this.add(
      el(
        'div',
        { class: 'msg-error' },
        el('span', {}, message),
        onRetry ? el('button', { class: 'btn small', type: 'button', onclick: onRetry }, 'Retry') : null,
      ),
    );
    scrollIfPinned();
  }

  meta(meta) {
    if (!meta) return;
    const bits = [meta.model];
    if (meta.cost != null) bits.push(formatCost(meta.cost));
    if (meta.inputTokens || meta.outputTokens) bits.push(`${meta.inputTokens} in / ${meta.outputTokens} out`);
    this.add(el('div', { class: 'turn-meta' }, bits.filter(Boolean).join(' · ')));
  }

  finish() {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.flush();
    this.tail?.remove();
    this.tail = null;
    for (const card of this.cards.values()) {
      if (card.status.classList.contains('running')) {
        card.status.className = 'tool-state err';
        card.status.textContent = 'cancelled';
        card.result.textContent = 'Cancelled.';
        card.card.querySelector('.approval')?.remove();
      }
    }
    if (!this.root.childElementCount) this.root.remove();
  }
}

function isPinned() {
  return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 120;
}
let pinned = true;
messagesEl.addEventListener('scroll', () => (pinned = isPinned()));
function scrollIfPinned() {
  if (pinned) messagesEl.scrollTop = messagesEl.scrollHeight;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => p.text || '').join('\n');
  return '';
}

function renderConversation() {
  messagesEl.replaceChildren();
  const conv = current();
  if (!conv || !conv.messages.length) {
    renderEmptyState();
    return;
  }
  let view = null;
  for (const m of conv.messages) {
    if (m.role === 'user') {
      view = null;
      messagesEl.append(el('div', { class: 'msg user' }, el('div', { class: 'bubble' }, textOf(m.content))));
      continue;
    }
    view ||= new TurnView(messagesEl);
    if (m.role === 'assistant') {
      if (m.reasoning) view.reasoningDelta(m.reasoning);
      if (m.content) view.delta(textOf(m.content));
      view.endSegment();
      for (const tc of m.tool_calls || []) {
        view.toolCall({ id: tc.id, name: tc.function.name, arguments: tc.function.arguments });
      }
    } else if (m.role === 'tool') {
      view.toolResult({ id: m.tool_call_id, content: m.content, isError: m.isError });
    }
    if (m.meta) view.meta(m.meta);
  }
  view?.finish();
  pinned = true;
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function renderEmptyState() {
  const toolCount = connectedToolCount();
  const suggestions = toolCount
    ? ['What tools do you have access to?', 'What time is it in Tokyo right now?', 'Use the calculator: (17 × 23)² ÷ 7']
    : ['Explain MCP in two sentences', 'Write a haiku about APIs', 'Give me 3 project ideas'];
  messagesEl.append(
    el(
      'div',
      { class: 'empty' },
      el('h1', {}, 'What can I help with?'),
      el(
        'div',
        {},
        `Chatting with ${modelInfo(state.model)?.name || state.model || '…'}`,
        toolCount ? ` · ${toolCount} MCP tools available` : '',
      ),
      el(
        'div',
        { class: 'suggestions' },
        suggestions.map((s) => el('button', { type: 'button', onclick: () => send(s) }, s)),
      ),
    ),
  );
}

// ---------- Conversations sidebar ----------

function renderSidebar() {
  const list = $('#conversations');
  const sorted = [...state.conversations].sort((a, b) => b.updatedAt - a.updatedAt);
  list.replaceChildren(
    ...sorted.map((c) =>
      el(
        'a',
        {
          class: `conv${c.id === state.currentId ? ' active' : ''}`,
          href: '#',
          onclick: (e) => {
            e.preventDefault();
            selectConversation(c.id);
          },
        },
        el('span', { class: 'conv-title' }, c.title || 'New chat'),
        el(
          'button',
          {
            class: 'conv-delete',
            type: 'button',
            title: 'Delete chat',
            onclick: (e) => {
              e.preventDefault();
              e.stopPropagation();
              deleteConversation(c.id);
            },
          },
          '✕',
        ),
      ),
    ),
  );
}

function selectConversation(id) {
  if (id && id === state.currentId) return closeSidebar();
  if (state.abort) state.abort.abort();
  state.currentId = id;
  saveConversations();
  renderSidebar();
  renderConversation();
  updateCost();
  closeSidebar();
}

function newConversation() {
  selectConversation(null);
  input.focus();
}

function deleteConversation(id) {
  if (!confirm('Delete this chat?')) return;
  if (id === state.currentId && state.abort) state.abort.abort();
  state.conversations = state.conversations.filter((c) => c.id !== id);
  if (state.currentId === id) state.currentId = null;
  saveConversations();
  renderSidebar();
  renderConversation();
  updateCost();
}

function updateCost() {
  const conv = current();
  const total = conv?.messages.reduce((sum, m) => sum + (m.meta?.cost || 0), 0) || 0;
  $('#cost').textContent = total ? `Chat cost ${formatCost(total)}` : '';
}

// ---------- Sending ----------

function setStreaming(on) {
  const button = $('#send');
  button.textContent = on ? 'Stop' : 'Send';
  button.classList.toggle('danger', on);
  button.classList.toggle('primary', !on);
}

async function send(text) {
  text = text.trim();
  if (!text || state.abort) return;
  if (!state.model) return alert('Pick a model first.');
  let conv = current();
  if (!conv) {
    conv = { id: uid(), title: text.slice(0, 60), messages: [], updatedAt: Date.now() };
    state.conversations.push(conv);
    state.currentId = conv.id;
  }
  conv.messages.push({ role: 'user', content: text });
  conv.updatedAt = Date.now();
  saveConversations();
  renderSidebar();
  renderConversation();
  await runTurn(conv);
}

async function runTurn(conv) {
  const view = new TurnView(messagesEl, { live: true });
  pinned = true;
  scrollIfPinned();
  const abort = new AbortController();
  state.abort = abort;
  setStreaming(true);

  const model = state.model;
  let added = []; // messages built from events, replaced by the server's copy on "done"
  let inProgress = null; // assistant message currently streaming
  let usage = null;
  let finished = false;
  let failure = null;
  let runId = null;
  const decide = (id) => (approved) =>
    api('/api/chat/approve', { method: 'POST', body: { runId, id, approved } });

  const lastAssistant = () => [...added].reverse().find((m) => m.role === 'assistant');

  try {
    const res = await api('/api/chat', {
      method: 'POST',
      signal: abort.signal,
      body: {
        model,
        messages: conv.messages,
        system: state.settings.system || undefined,
        temperature: state.settings.temperature ?? undefined,
        useTools: state.useTools,
        confirmTools: state.confirmTools,
      },
    });
    for await (const event of readEvents(res.body)) {
      switch (event.type) {
        case 'run':
          runId = event.runId;
          break;
        case 'reasoning':
          view.reasoningDelta(event.content);
          inProgress ||= { role: 'assistant', content: null };
          inProgress.reasoning = (inProgress.reasoning || '') + event.content;
          break;
        case 'delta':
          view.delta(event.content);
          inProgress ||= { role: 'assistant', content: null };
          inProgress.content = (inProgress.content || '') + event.content;
          break;
        case 'assistant_end':
          view.endSegment();
          added.push(inProgress || { role: 'assistant', content: null });
          inProgress = null;
          break;
        case 'tool_call': {
          view.toolCall(event, decide(event.id));
          const owner = lastAssistant();
          if (owner) {
            owner.tool_calls ||= [];
            owner.tool_calls.push({ id: event.id, type: 'function', function: { name: event.name, arguments: event.arguments } });
          }
          break;
        }
        case 'tool_progress':
          view.toolProgress(event);
          break;
        case 'tool_result':
          view.toolResult(event);
          added.push({ role: 'tool', tool_call_id: event.id, content: event.content, isError: event.isError });
          break;
        case 'notice':
          view.notice(event.message);
          break;
        case 'usage':
          usage = event;
          break;
        case 'error':
          throw new Error(event.message);
        case 'done':
          added = event.messages;
          inProgress = null;
          finished = true;
          break;
      }
    }
    if (!finished) throw new Error('The connection closed before the reply finished.');
  } catch (err) {
    failure = abort.signal.aborted ? null : err;
  } finally {
    if (!finished) added = repairPartial(added, inProgress);
    const final = [...added].reverse().find((m) => m.role === 'assistant');
    if (final) final.meta = { model, cost: usage?.cost ?? null, inputTokens: usage?.inputTokens || 0, outputTokens: usage?.outputTokens || 0 };
    if (finished) view.meta(final?.meta);
    conv.messages.push(...added);
    conv.updatedAt = Date.now();
    saveConversations();
    renderSidebar();
    view.finish();
    if (abort.signal.aborted && !finished) view.notice('Stopped.');
    if (failure) {
      const last = conv.messages.at(-1);
      const canRetry = last && (last.role === 'user' || last.role === 'tool');
      view.error(failure.message, canRetry && (() => {
        if (state.currentId !== conv.id) return;
        renderConversation();
        runTurn(conv);
      }));
    }
    if (state.abort === abort) state.abort = null;
    setStreaming(Boolean(state.abort));
    updateCost();
  }
}

/** Makes a partial turn safe to send back: every tool call needs a matching result. */
function repairPartial(added, inProgress) {
  const out = [...added];
  const answered = new Set(out.filter((m) => m.role === 'tool').map((m) => m.tool_call_id));
  for (const m of added) {
    for (const tc of m.tool_calls || []) {
      if (!answered.has(tc.id)) out.push({ role: 'tool', tool_call_id: tc.id, content: 'Cancelled by the user.', isError: true });
    }
  }
  if (inProgress && (inProgress.content || inProgress.reasoning)) out.push(inProgress);
  return out;
}

$('#composer').addEventListener('submit', (e) => {
  e.preventDefault();
  if (state.abort) {
    state.abort.abort();
    return;
  }
  const text = input.value;
  if (!text.trim()) return;
  input.value = '';
  autosize();
  send(text);
});

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $('#composer').requestSubmit();
  }
});

function autosize() {
  input.style.height = 'auto';
  input.style.height = `${input.scrollHeight}px`;
}
input.addEventListener('input', autosize);

// ---------- Model picker ----------

const modelInfo = (id) => state.models.find((m) => m.id === id);

function setModel(id) {
  state.model = id;
  store.set('model', id);
  const info = modelInfo(id);
  $('#model-name').textContent = info?.name || id;
  $('#model-button').title = id;
  updateToolsHint();
  if (!current()?.messages.length) renderConversation();
}

let modelFocus = 0;

function renderModelList() {
  const words = $('#model-search').value.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = state.models.filter((m) => {
    if (state.toolsOnly && !m.toolCalling) return false;
    const hay = `${m.id} ${m.name}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  const shown = matches.slice(0, 150);
  modelFocus = Math.min(modelFocus, Math.max(shown.length - 1, 0));
  const list = $('#model-list');
  list.replaceChildren(
    ...shown.map((m, i) =>
      el(
        'li',
        {
          role: 'option',
          class: [m.id === state.model && 'selected', i === modelFocus && 'focused'].filter(Boolean).join(' '),
          'data-id': m.id,
          onclick: () => pickModel(m.id),
        },
        el('span', { class: 'm-name' }, m.name),
        el(
          'span',
          { class: 'm-badges' },
          m.toolCalling ? el('span', { class: 'badge tools' }, 'tools') : null,
          m.vision ? el('span', { class: 'badge' }, 'vision') : null,
          m.reasoning ? el('span', { class: 'badge' }, 'reasoning') : null,
        ),
        el('span', { class: 'm-id' }, m.id),
        el(
          'span',
          { class: 'm-price' },
          m.pricing ? `${formatPrice(m.pricing.prompt)} / ${formatPrice(m.pricing.completion)}` : '',
        ),
      ),
    ),
  );
  if (matches.length > shown.length) {
    list.append(el('li', { class: 'm-more' }, `${matches.length - shown.length} more — refine your search`));
  }
  if (!matches.length) list.append(el('li', { class: 'm-more' }, 'No models match'));
}

function pickModel(id) {
  setModel(id);
  closeModelMenu();
}

function openModelMenu() {
  $('#model-menu').hidden = false;
  $('#model-search').value = '';
  modelFocus = 0;
  renderModelList();
  $('#model-list li.selected')?.scrollIntoView({ block: 'nearest' });
  $('#model-search').focus();
}

function closeModelMenu() {
  $('#model-menu').hidden = true;
}

$('#model-button').addEventListener('click', () => ($('#model-menu').hidden ? openModelMenu() : closeModelMenu()));
$('#model-search').addEventListener('input', () => {
  modelFocus = 0;
  renderModelList();
});
$('#model-search').addEventListener('keydown', (e) => {
  const items = [...$('#model-list').querySelectorAll('li[data-id]')];
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    modelFocus = Math.max(0, Math.min(items.length - 1, modelFocus + (e.key === 'ArrowDown' ? 1 : -1)));
    items.forEach((li, i) => li.classList.toggle('focused', i === modelFocus));
    items[modelFocus]?.scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (items[modelFocus]) pickModel(items[modelFocus].dataset.id);
  } else if (e.key === 'Escape') {
    closeModelMenu();
    $('#model-button').focus();
  }
});
$('#tools-only').checked = state.toolsOnly;
$('#tools-only').addEventListener('change', (e) => {
  state.toolsOnly = e.target.checked;
  store.set('toolsOnly', state.toolsOnly);
  renderModelList();
});
document.addEventListener('click', (e) => {
  if (!$('#model-picker').contains(e.target)) closeModelMenu();
});

async function loadModels() {
  try {
    const { models } = await (await api('/api/models')).json();
    state.models = models;
  } catch (err) {
    $('#model-name').textContent = 'Could not load models';
    console.error(err);
  }
  if (!state.model || (state.models.length && !modelInfo(state.model))) {
    state.model = state.config.defaultModel;
  }
  if (state.model) setModel(state.model);
}

// ---------- MCP tools ----------

function connectedToolCount() {
  return state.servers.filter((s) => s.status === 'connected').reduce((n, s) => n + s.tools.length, 0);
}

function updateToolsHint() {
  const count = connectedToolCount();
  $('#tools-label').textContent = count ? `MCP tools (${count})` : 'MCP tools';
  $('#mcp-count').textContent = state.servers.length ? `${state.servers.filter((s) => s.status === 'connected').length}/${state.servers.length}` : '';
  let hint = '';
  if (state.useTools) {
    if (modelInfo(state.model)?.toolCalling === false) hint = "This model doesn't support tool calling";
    else if (!count) hint = 'No MCP tools connected';
  }
  $('#tools-hint').textContent = hint;
}

$('#confirm-tools').checked = state.confirmTools;
$('#confirm-tools').addEventListener('change', (e) => {
  state.confirmTools = e.target.checked;
  store.set('confirmTools', state.confirmTools);
});

$('#use-tools').checked = state.useTools;
$('#use-tools').addEventListener('change', (e) => {
  state.useTools = e.target.checked;
  store.set('useTools', state.useTools);
  updateToolsHint();
});

async function loadServers() {
  try {
    state.servers = (await (await api('/api/mcp/servers')).json()).servers;
  } catch (err) {
    console.error(err);
  }
  renderServers();
}

function setServers(servers) {
  state.servers = servers;
  renderServers();
}

function renderServers() {
  updateToolsHint();
  const list = $('#server-list');
  if (!state.servers.length) {
    list.replaceChildren(el('p', { class: 'muted' }, 'No MCP servers yet. Add one below.'));
    return;
  }
  list.replaceChildren(
    ...state.servers.map((s) => {
      const action = (label, fn, cls = '') =>
        el('button', {
          class: `btn small ${cls}`,
          type: 'button',
          onclick: async (e) => {
            const button = e.currentTarget;
            button.disabled = true;
            button.textContent = '…';
            try {
              await fn();
            } catch (err) {
              alert(err.message);
            } finally {
              renderServers();
            }
          },
        }, label);
      const name = encodeURIComponent(s.name);
      return el(
        'div',
        { class: 'server' },
        el(
          'div',
          { class: 'server-head' },
          el('span', { class: `dot ${s.status}`, title: s.status }),
          el('span', { class: 'server-name' }, s.name),
          el('span', { class: 'badge' }, s.type),
          el('span', { class: 'muted' }, s.disabled ? 'disabled' : s.status),
          el(
            'span',
            { class: 'server-actions' },
            !s.disabled && action('Reconnect', async () => setServers((await (await api(`/api/mcp/servers/${name}/reconnect`, { method: 'POST' })).json()).servers)),
            action(s.disabled ? 'Enable' : 'Disable', async () =>
              setServers((await (await api(`/api/mcp/servers/${name}`, { method: 'PATCH', body: { disabled: !s.disabled } })).json()).servers)),
            action('Remove', async () => {
              if (!confirm(`Remove MCP server "${s.name}"?`)) return;
              setServers((await (await api(`/api/mcp/servers/${name}`, { method: 'DELETE' })).json()).servers);
            }, 'danger'),
          ),
        ),
        el('div', { class: 'server-target' }, s.target),
        s.error ? el('div', { class: 'server-error' }, s.error) : null,
        s.tools.length
          ? el(
              'details',
              {},
              el('summary', {}, `${s.tools.length} tool${s.tools.length === 1 ? '' : 's'}`),
              el('ul', {}, s.tools.map((t) => el('li', {}, el('code', {}, t.name), t.description ? ` — ${t.description}` : ''))),
            )
          : null,
      );
    }),
  );
}

const addForm = $('#add-server');

function syncServerType() {
  const type = addForm.elements.type.value;
  for (const section of addForm.querySelectorAll('[data-for]')) {
    section.hidden = !section.dataset.for.split(' ').includes(type);
  }
  const note = $('#stdio-note');
  note.hidden = !(type === 'stdio' && !state.config.uiStdioAllowed);
  note.textContent = 'Adding stdio servers from the browser is disabled because the server is public and has no ACCESS_TOKEN. Add them to mcp-servers.json instead.';
}
addForm.elements.type.addEventListener('change', syncServerType);

function parseLines(text, separator) {
  const out = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf(separator);
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

function serversFromForm() {
  const f = addForm.elements;
  const json = f.json.value.trim();
  if (json) {
    const parsed = JSON.parse(json);
    if (parsed.mcpServers) return Object.entries(parsed.mcpServers);
    if (parsed.command || parsed.url) {
      if (!f.name.value.trim()) throw new Error('Enter a name for this server.');
      return [[f.name.value.trim(), parsed]];
    }
    return Object.entries(parsed);
  }
  const name = f.name.value.trim();
  if (!name) throw new Error('Enter a name for this server.');
  const type = f.type.value;
  if (type === 'stdio') {
    const config = {
      command: f.command.value.trim(),
      args: f.args.value.split('\n').map((s) => s.trim()).filter(Boolean),
    };
    const env = parseLines(f.env.value, '=');
    if (Object.keys(env).length) config.env = env;
    return [[name, config]];
  }
  const config = { type, url: f.url.value.trim() };
  const headers = parseLines(f.headers.value, ':');
  if (Object.keys(headers).length) config.headers = headers;
  return [[name, config]];
}

addForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const status = $('#add-status');
  const button = addForm.querySelector('button[type=submit]');
  let entries;
  try {
    entries = serversFromForm();
    if (!entries.length) throw new Error('Nothing to add.');
  } catch (err) {
    status.textContent = err.message;
    return;
  }
  button.disabled = true;
  const problems = [];
  for (const [name, config] of entries) {
    status.textContent = `Connecting to ${name}…`;
    try {
      const { servers } = await (await api('/api/mcp/servers', { method: 'POST', body: { name, config } })).json();
      setServers(servers);
      const added = servers.find((s) => s.name === name);
      if (added?.status === 'error') problems.push(`${name}: ${added.error}`);
    } catch (err) {
      problems.push(`${name}: ${err.message}`);
    }
  }
  button.disabled = false;
  status.textContent = problems.length ? problems.join('\n') : 'Connected.';
  if (!problems.length) {
    addForm.reset();
    syncServerType();
  }
});

// ---------- Dialogs ----------

for (const dialog of document.querySelectorAll('dialog')) {
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog || e.target.closest('[data-close]')) dialog.close();
  });
}

$('#open-mcp').addEventListener('click', () => {
  closeSidebar();
  $('#add-status').textContent = '';
  syncServerType();
  $('#mcp-dialog').showModal();
  loadServers();
});

function openSettings({ focusToken = false } = {}) {
  const dialog = $('#settings-dialog');
  const f = $('#settings-form').elements;
  f.system.value = state.settings.system || '';
  f.temperature.value = state.settings.temperature ?? '';
  f.token.value = state.token;
  $('#token-field').hidden = !(state.config.authRequired || state.token);
  if (!dialog.open) dialog.showModal();
  if (focusToken) {
    $('#token-field').hidden = false;
    f.token.focus();
  }
}

$('#open-settings').addEventListener('click', () => {
  closeSidebar();
  openSettings();
});

$('#settings-form').addEventListener('submit', () => {
  const f = $('#settings-form').elements;
  const temperature = f.temperature.value === '' ? null : Number(f.temperature.value);
  state.settings = { system: f.system.value, temperature: Number.isFinite(temperature) ? temperature : null };
  store.set('settings', state.settings);
  const tokenChanged = f.token.value !== state.token;
  state.token = f.token.value;
  store.set('token', state.token);
  if (tokenChanged) {
    loadModels();
    loadServers();
  }
});

$('#clear-chats').addEventListener('click', () => {
  if (!confirm('Delete all chats? This cannot be undone.')) return;
  if (state.abort) state.abort.abort();
  state.conversations = [];
  state.currentId = null;
  saveConversations();
  renderSidebar();
  renderConversation();
  updateCost();
  $('#settings-dialog').close();
});

// ---------- Sidebar (mobile) ----------

const closeSidebar = () => $('#app').classList.remove('sidebar-open');
$('#toggle-sidebar').addEventListener('click', () => $('#app').classList.toggle('sidebar-open'));
$('#scrim').addEventListener('click', closeSidebar);
$('#new-chat').addEventListener('click', newConversation);

// ---------- Start ----------

async function init() {
  try {
    state.config = await (await fetch('/api/config')).json();
  } catch {
    state.config = {};
  }
  if (state.config.authRequired && !state.token) openSettings({ focusToken: true });
  if (state.currentId && !current()) state.currentId = null;
  renderSidebar();
  renderConversation();
  updateCost();
  await Promise.all([loadModels(), loadServers()]);
  if (!current()?.messages.length) renderConversation();
  input.focus();
}

init();
