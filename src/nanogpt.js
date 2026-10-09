// Minimal client for NanoGPT's OpenAI-compatible API (https://nano-gpt.com/api).

const MODELS_TTL_MS = 10 * 60 * 1000;

export class NanoGPTError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'NanoGPTError';
    this.status = status;
  }
}

export class NanoGPT {
  constructor({ apiKey, baseUrl }) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this._models = null;
    this._modelsAt = 0;
  }

  _headers() {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };
  }

  async _check(res) {
    if (res.ok) return res;
    const body = await res.text().catch(() => '');
    let message = body;
    try {
      const json = JSON.parse(body);
      message = json.error?.message || json.message || json.error || body;
    } catch {
      // Not JSON; keep raw text.
    }
    if (typeof message !== 'string') message = JSON.stringify(message);
    throw new NanoGPTError(`NanoGPT ${res.status}: ${message || res.statusText}`, res.status);
  }

  /** Returns a simplified, cached list of models with their capabilities. */
  async listModels({ force = false } = {}) {
    if (!force && this._models && Date.now() - this._modelsAt < MODELS_TTL_MS) {
      return this._models;
    }
    const res = await this._check(
      await fetch(`${this.baseUrl}/models?detailed=true`, { headers: this._headers() }),
    );
    const json = await res.json();
    this._models = (json.data || []).map((m) => ({
      id: m.id,
      name: m.name || m.id,
      description: m.description || '',
      ownedBy: m.owned_by || '',
      contextLength: m.context_length || null,
      toolCalling: m.capabilities ? Boolean(m.capabilities.tool_calling) : null,
      vision: Boolean(m.capabilities?.vision),
      reasoning: Boolean(m.capabilities?.reasoning),
      pricing: m.pricing
        ? { prompt: m.pricing.prompt ?? null, completion: m.pricing.completion ?? null }
        : null,
      subscription: Boolean(m.subscription?.included),
    }));
    this._modelsAt = Date.now();
    return this._models;
  }

  /** Looks up a model's metadata without failing if the list can't be fetched. */
  async getModel(id) {
    try {
      return (await this.listModels()).find((m) => m.id === id) || null;
    } catch {
      return null;
    }
  }

  /** Non-streaming chat completion. Returns the raw OpenAI-style response. */
  async chat({ model, messages, tools, temperature, maxTokens, signal }) {
    const body = { model, messages, stream: false };
    if (tools?.length) body.tools = tools;
    if (temperature != null) body.temperature = temperature;
    if (maxTokens != null) body.max_tokens = maxTokens;
    const res = await this._check(
      await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this._headers(),
        body: JSON.stringify(body),
        signal,
      }),
    );
    return res.json();
  }

  /** Streaming chat completion. Yields parsed `chat.completion.chunk` objects. */
  async *streamChat({ model, messages, tools, toolChoice, temperature, maxTokens, signal }) {
    const body = { model, messages, stream: true, stream_options: { include_usage: true } };
    if (tools?.length) body.tools = tools;
    if (tools?.length && toolChoice) body.tool_choice = toolChoice;
    if (temperature != null) body.temperature = temperature;
    if (maxTokens != null) body.max_tokens = maxTokens;
    const res = await this._check(
      await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { ...this._headers(), Accept: 'text/event-stream' },
        body: JSON.stringify(body),
        signal,
      }),
    );

    // Some upstreams ignore `stream: true`; handle a plain JSON reply too.
    const type = res.headers.get('content-type') || '';
    if (type.includes('application/json')) {
      const json = await res.json();
      if (json.error) throw new NanoGPTError(json.error.message || JSON.stringify(json.error));
      yield completionToChunk(json);
      return;
    }

    for await (const data of sseData(res.body)) {
      if (data === '[DONE]') return;
      let chunk;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      if (chunk.error) {
        throw new NanoGPTError(chunk.error.message || JSON.stringify(chunk.error));
      }
      yield chunk;
    }
  }
}

/** Parses a ReadableStream of Server-Sent Events, yielding each event's `data` payload. */
export async function* sseData(stream) {
  const decoder = new TextDecoder();
  let buffer = '';
  let dataLines = [];
  const reader = stream.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.search(/\r?\n/)) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(buffer[newline] === '\r' ? newline + 2 : newline + 1);
        if (line === '') {
          if (dataLines.length) yield dataLines.join('\n');
          dataLines = [];
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).replace(/^ /, ''));
        }
      }
      if (done) break;
    }
    if (buffer.startsWith('data:')) dataLines.push(buffer.slice(5).replace(/^ /, ''));
    if (dataLines.length) yield dataLines.join('\n');
  } finally {
    reader.releaseLock();
  }
}

function completionToChunk(json) {
  const choice = json.choices?.[0] || {};
  const message = choice.message || {};
  return {
    ...json,
    choices: [
      {
        index: 0,
        finish_reason: choice.finish_reason,
        delta: {
          role: 'assistant',
          content: message.content ?? null,
          reasoning: message.reasoning ?? message.reasoning_content,
          tool_calls: message.tool_calls?.map((tc, index) => ({ index, ...tc })),
        },
      },
    ],
  };
}
