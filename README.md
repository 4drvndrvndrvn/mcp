# NanoGPT MCP Chat

A small Node.js server and web chat UI for the [NanoGPT API](https://nano-gpt.com/api). You can chat with any of NanoGPT's 600+ models, and the model can call tools from any [MCP](https://modelcontextprotocol.io) server you connect.

- **Web chat**: streams replies, renders Markdown, shows reasoning, and lets you search and filter models by tool support, vision and price. Chats are saved in your browser, and each reply shows its cost.
- **MCP tools**: connect stdio, Streamable HTTP or SSE MCP servers from the UI or a config file. Their tools are passed to the model, which can call them over several rounds. Each call shows up as a card with its arguments and result.
- **MCP server**: the app is also an MCP server at `/mcp`, so Claude Code, Claude Desktop, Cursor and other MCP clients can send prompts through NanoGPT models.

## Quick start

Requires Node.js 20.12 or newer.

```bash
npm install
cp .env.example .env        # then set NANOGPT_API_KEY in .env
npm start
```

Then open http://localhost:3000.

On the first start the app creates `mcp-servers.json` from `mcp-servers.example.json`. That file connects a demo MCP server (`examples/demo-server.js`) with three tools: `get_current_time`, `calculate` and `random_number`. Try asking *"What time is it in Tokyo?"*.

## Adding MCP servers

Click **MCP servers** in the sidebar to add, reconnect, disable or remove servers. You can also paste the `{"mcpServers": {...}}` JSON shown in most MCP server READMEs. Changes are saved to `mcp-servers.json`, and you can also edit that file directly and restart:

```json
{
  "mcpServers": {
    "demo": { "command": "node", "args": ["examples/demo-server.js"] },

    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/folder"]
    },

    "fetch": { "command": "uvx", "args": ["mcp-server-fetch"] },

    "github": {
      "url": "https://api.githubcopilot.com/mcp/",
      "headers": { "Authorization": "Bearer ${GITHUB_TOKEN}" }
    },

    "legacy-sse": { "type": "sse", "url": "https://example.com/sse", "disabled": true }
  }
}
```

- `type` is `stdio` (the default when `command` is set), `http` (the default when `url` is set) or `sse`. An `http` server that doesn't support Streamable HTTP is retried over SSE.
- In `args`, `env`, `url` and `headers`, `${VAR}` is replaced with the value of that environment variable on the server, so secrets can stay in `.env`.
- Stdio servers get only a minimal environment (PATH, HOME, …) plus whatever you list in `env`. Your NanoGPT key is not passed to them.
- Tools are offered to the model only when the **MCP tools** switch is on and the selected model supports tool calling. A model can make at most `MAX_TOOL_ROUNDS` rounds of tool calls per reply.

## Using it as an MCP server

`POST /mcp` is a stateless Streamable HTTP MCP endpoint with two tools:

| Tool | What it does |
| --- | --- |
| `chat` | Sends a `prompt` (plus optional `model`, `system`, `temperature`, `use_tools`) to NanoGPT and returns the reply. With `use_tools: true`, the model can also use the MCP servers configured above. |
| `list_models` | Lists model ids, optionally filtered by `search` or `tool_calling_only`. |

Claude Code:

```bash
claude mcp add --transport http nanogpt http://localhost:3000/mcp
# if ACCESS_TOKEN is set:
claude mcp add --transport http nanogpt http://localhost:3000/mcp --header "Authorization: Bearer <token>"
```

Clients that only support stdio can use [`mcp-remote`](https://www.npmjs.com/package/mcp-remote):

```json
{ "mcpServers": { "nanogpt": { "command": "npx", "args": ["-y", "mcp-remote", "http://localhost:3000/mcp"] } } }
```

## Configuration (`.env`)

| Variable | Default | Description |
| --- | --- | --- |
| `NANOGPT_API_KEY` | — | **Required.** Your NanoGPT API key. |
| `DEFAULT_MODEL` | `openai/gpt-5.4-mini` | The model selected in a new browser. |
| `HOST` | `127.0.0.1` | Interface to listen on. |
| `PORT` | `3000` | Port to listen on. |
| `ACCESS_TOKEN` | — | If set, the API and `/mcp` require `Authorization: Bearer <token>`. The UI asks for it once. |
| `MAX_TOOL_ROUNDS` | `10` | The most rounds of tool calls in one reply. |
| `MCP_CONFIG` | `./mcp-servers.json` | Path to the MCP servers file. |
| `NANOGPT_BASE_URL` | `https://nano-gpt.com/api/v1` | API base URL. |

## Security

- By default the server listens only on `127.0.0.1` and rejects requests whose `Host` header isn't `localhost`, `127.0.0.1` or `[::1]`, which blocks DNS-rebinding attacks.
- **Set `ACCESS_TOKEN` before using `HOST=0.0.0.0`.** Anyone who can reach the port can spend your NanoGPT credits. A stdio MCP server runs a command on the host, so without a token the UI can't add stdio servers when the host is public.
- MCP tools run with your permissions. Only connect servers you trust, and be careful with tools that write files or run commands.
- `.env` and `mcp-servers.json` are git-ignored because they can hold secrets.

## HTTP API

| Method & path | Description |
| --- | --- |
| `GET /api/config` | Public settings: default model and whether auth is required. |
| `GET /api/models` | Models with their capabilities and prices (cached for 10 minutes; `?refresh=1` reloads them). |
| `GET /api/mcp/servers` | MCP servers with their status and tools. |
| `POST /api/mcp/servers` | `{ "name", "config" }` adds a server (or replaces one with the same name) and connects it. |
| `PATCH /api/mcp/servers/:name` | `{ "disabled": true \| false }` |
| `POST /api/mcp/servers/:name/reconnect` | Reconnects a server. |
| `DELETE /api/mcp/servers/:name` | Removes a server. |
| `POST /api/chat` | `{ model, messages, system?, temperature?, useTools?, servers? }` returns a Server-Sent Events stream. |

`/api/chat` sends one JSON event per message: `delta` and `reasoning` (text chunks), `assistant_end`, `tool_call`, `tool_result`, `notice`, `usage`, `error`, and finally `done`. The `done` event carries `messages`: everything added during the turn (assistant messages, tool calls and tool results) in OpenAI format. Append them to your history for the next request.

## Development

```bash
npm run dev    # restart on file changes
npm test       # unit tests (node:test)
```

```
server.js              Express app: API, static UI, /mcp endpoint
src/nanogpt.js         NanoGPT client (models, streaming chat, SSE parsing)
src/mcp.js             MCP client manager (stdio / HTTP / SSE, tool mapping)
src/agent.js           Tool-calling loop between the model and MCP servers
src/mcp-endpoint.js    This app as an MCP server
public/                Web UI (no build step)
examples/              Demo stdio MCP server
```
