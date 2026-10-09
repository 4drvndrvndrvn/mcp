// Exposes this app as an MCP server (Streamable HTTP at /mcp), so other MCP
// clients (Claude Desktop, Cursor, ...) can run prompts through NanoGPT models.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { runAgent } from './agent.js';

function createServer({ nano, mcp, config }) {
  const server = new McpServer({ name: 'nanogpt', version: '1.0.0' });

  server.registerTool(
    'chat',
    {
      title: 'Ask a NanoGPT model',
      description:
        'Send a prompt to any model available on NanoGPT and return its reply. ' +
        "Optionally let the model use this server's read-only MCP tools (tools that change things need approval in the web UI).",
      inputSchema: {
        prompt: z.string().describe('The user prompt'),
        model: z.string().optional().describe(`Model id (default: ${config.defaultModel}). See list_models.`),
        system: z.string().optional().describe('Optional system prompt'),
        temperature: z.number().min(0).max(2).optional(),
        use_tools: z.boolean().optional().describe("Let the model call this server's read-only MCP tools (default false)"),
      },
    },
    async ({ prompt, model, system, temperature, use_tools }, extra) => {
      const added = await runAgent({
        nano,
        mcp,
        model: model || config.defaultModel,
        messages: [{ role: 'user', content: prompt }],
        system,
        temperature,
        useTools: Boolean(use_tools),
        // There is no one to approve tool calls here, so only offer tools that can't change anything.
        readOnlyTools: true,
        maxRounds: config.maxToolRounds,
        signal: extra.signal,
      });
      const reply = added.filter((m) => m.role === 'assistant' && m.content).map((m) => m.content).at(-1);
      return { content: [{ type: 'text', text: reply || '(empty reply)' }] };
    },
  );

  server.registerTool(
    'list_models',
    {
      title: 'List NanoGPT models',
      description: 'List model ids available on NanoGPT, optionally filtered.',
      inputSchema: {
        search: z.string().optional().describe('Case-insensitive substring to match against id or name'),
        tool_calling_only: z.boolean().optional().describe('Only models that support tool calling'),
        limit: z.number().int().min(1).max(1000).optional().describe('Max results (default 100)'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ search, tool_calling_only, limit = 100 }) => {
      const q = (search || '').toLowerCase();
      const models = (await nano.listModels())
        .filter((m) => !q || m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q))
        .filter((m) => !tool_calling_only || m.toolCalling)
        .slice(0, limit);
      const lines = models.map((m) => {
        const price = m.pricing ? ` ($${m.pricing.prompt}/$${m.pricing.completion} per 1M tokens)` : '';
        return `${m.id} — ${m.name}${m.toolCalling ? ' [tools]' : ''}${price}`;
      });
      return { content: [{ type: 'text', text: lines.join('\n') || 'No models matched.' }] };
    },
  );

  return server;
}

/** Express handler for POST /mcp (stateless Streamable HTTP). */
export function mcpEndpoint(deps) {
  return async (req, res) => {
    const server = createServer(deps);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('[/mcp]', err);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
      }
    }
  };
}
