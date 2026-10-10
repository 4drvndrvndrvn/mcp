// Exposes this app as an MCP server (Streamable HTTP at /mcp) for Claude and other MCP
// clients. It offers the tools of the MCP servers configured in mcp-servers.json
// (vast, ssh, web, ...) under their own names, plus `chat` and `list_models`, which run
// prompts through NanoGPT models.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { runAgent } from './agent.js';

export const INSTRUCTIONS = `\
Tools named vast_* rent and drive machines on Vast.ai; ssh_* run commands on other servers; web_search looks things up.

To work in a graphical Linux desktop (for example to run Roblox Studio):
1. vast_search_templates with query "desktop", then vast_search_offers with its template_hash, then vast_create_instance \
(set auto_destroy_minutes as a safety net; billing runs until vast_destroy_instance).
2. vast_wait_for_instance, then vast_exec to install software. Installers that refuse root need run_as_user "user".
3. vast_screenshot to see the screen, vast_desktop to click, type, press keys, paste text and launch apps \
(coordinates are in the screenshot's pixels). Paste code into editors instead of typing it.
4. When an app needs the user to sign in, stop and ask them to do it themselves: they open the desktop in their browser \
from the instance's "Open" button at https://cloud.vast.ai/instances/. Never ask for their password.
5. Destroy the instance when the user is done with it.

Roblox Studio on Linux: TuxBlox (https://tuxblox.net) installs it with \`curl -sSLf https://tuxblox.net/install.sh | bash\` \
as a normal user. It needs Linux kernel 6.7+ and a Vulkan driver on the host (check uname -r and vulkaninfo --summary).`;

const chatInput = z.object({
  prompt: z.string().describe('The user prompt'),
  model: z.string().optional().describe('Model id (see list_models)'),
  system: z.string().optional().describe('Optional system prompt'),
  temperature: z.number().min(0).max(2).optional(),
  use_tools: z.boolean().optional().describe("Let the model call this server's read-only MCP tools (default false)"),
});

const listModelsInput = z.object({
  search: z.string().optional().describe('Case-insensitive substring to match against id or name'),
  tool_calling_only: z.boolean().optional().describe('Only models that support tool calling'),
  limit: z.number().int().min(1).max(1000).optional().describe('Max results (default 100)'),
});

const jsonSchema = (schema) => {
  const { $schema, ...rest } = z.toJSONSchema(schema);
  return rest;
};

const textResult = (text, isError = false) => ({ content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) });

/** Tools that run prompts through NanoGPT (only when an API key is set). */
function ownTools({ nano, mcp, config }) {
  if (!config.apiKey) return [];
  return [
    {
      definition: {
        name: 'chat',
        title: 'Ask a NanoGPT model',
        description:
          'Send a prompt to any model available on NanoGPT and return its reply. ' +
          "Optionally let the model use this server's read-only MCP tools.",
        inputSchema: jsonSchema(chatInput),
        annotations: { openWorldHint: true },
      },
      input: chatInput,
      async run({ prompt, model, system, temperature, use_tools }, extra) {
        const added = await runAgent({
          nano,
          mcp,
          model: model || config.defaultModel,
          messages: [{ role: 'user', content: prompt }],
          system,
          temperature,
          useTools: Boolean(use_tools),
          // The model behind this tool has nobody to approve its tool calls, so it only gets tools that can't change anything.
          readOnlyTools: true,
          maxRounds: config.maxToolRounds,
          signal: extra.signal,
        });
        const reply = added.filter((m) => m.role === 'assistant' && m.content).map((m) => m.content).at(-1);
        return textResult(reply || '(empty reply)');
      },
    },
    {
      definition: {
        name: 'list_models',
        title: 'List NanoGPT models',
        description: 'List model ids available on NanoGPT, optionally filtered.',
        inputSchema: jsonSchema(listModelsInput),
        annotations: { readOnlyHint: true },
      },
      input: listModelsInput,
      async run({ search, tool_calling_only, limit = 100 }) {
        const q = (search || '').toLowerCase();
        const models = (await nano.listModels())
          .filter((m) => !q || m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q))
          .filter((m) => !tool_calling_only || m.toolCalling)
          .slice(0, limit);
        const lines = models.map((m) => {
          const price = m.pricing ? ` ($${m.pricing.prompt}/$${m.pricing.completion} per 1M tokens)` : '';
          return `${m.id} — ${m.name}${m.toolCalling ? ' [tools]' : ''}${price}`;
        });
        return textResult(lines.join('\n') || 'No models matched.');
      },
    },
  ];
}

export function createServer({ nano, mcp, config }) {
  const server = new Server({ name: 'nanogpt-mcp-chat', version: '1.0.0' }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
  const own = ownTools({ nano, mcp, config });
  const ownByName = new Map(own.map((t) => [t.definition.name, t]));
  const exposed = () => mcp.getExposedTools(config.exposeServers, [...ownByName.keys()]);

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...own.map((t) => t.definition), ...exposed().map((t) => t.definition)],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args = {} } = request.params;
    const mine = ownByName.get(name);
    if (mine) {
      const parsed = mine.input.safeParse(args);
      if (!parsed.success) return textResult(`Invalid arguments for ${name}: ${parsed.error.message}`, true);
      return mine.run(parsed.data, extra);
    }
    const target = exposed().find((t) => t.definition.name === name);
    if (!target) return textResult(`Unknown tool "${name}". Its MCP server may be disconnected; list the tools again.`, true);
    const token = request.params._meta?.progressToken;
    try {
      return await mcp.callTool(target.server, target.tool, args, {
        signal: extra.signal,
        // Pass progress through, so long calls (waiting for an instance to boot) report status and stay alive.
        onProgress: ({ progress, total, message }) => {
          if (token === undefined) return;
          extra
            .sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress, total, message } })
            .catch(() => {});
        },
      });
    } catch (err) {
      return textResult(`Error: ${err.message}`, true);
    }
  });

  return server;
}

/** Express handler for POST /mcp (stateless Streamable HTTP). */
export function mcpEndpoint(deps) {
  return async (req, res) => {
    const server = createServer(deps);
    // Replies are streamed as SSE so progress notifications reach the client during long tool calls.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
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
