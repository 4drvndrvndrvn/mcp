# NanoGPT MCP Chat

A small Node.js server and web chat UI for the [NanoGPT API](https://nano-gpt.com/api). You can chat with any of NanoGPT's 600+ models, and the model can call tools from any [MCP](https://modelcontextprotocol.io) server you connect.

- **Web chat**: streams replies, renders Markdown, shows reasoning, and lets you search and filter models by tool support, vision and price. Chats are saved in your browser, and each reply shows its cost.
- **MCP tools**: connect stdio, Streamable HTTP or SSE MCP servers from the UI or a config file. Their tools are passed to the model, which can call them over several rounds. Each call shows up as a card with its arguments, live progress and result. Tools that can change things wait for you to click **Run**.
- **Built-in Vast.ai, SSH and web search tools**: the model can rent a GPU machine on [Vast.ai](https://vast.ai), run commands on it and destroy it, run commands on any server over SSH, and look things up on the web instead of guessing.
- **MCP server**: the app is also an MCP server at `/mcp`, so Claude Code, Claude Desktop, Cursor and other MCP clients can send prompts through NanoGPT models.

## Quick start

Requires Node.js 20.12 or newer.

```bash
npm install
cp .env.example .env        # then set NANOGPT_API_KEY in .env
npm start
```

Then open http://localhost:3000.

On the first start the app creates `mcp-servers.json` from `mcp-servers.example.json`, which connects three bundled MCP servers:

| Server | Tools |
| --- | --- |
| `demo` (`examples/demo-server.js`) | `get_current_time`, `calculate`, `random_number`, `wait` |
| `vast` (`servers/vast.js`) | Rent and drive Vast.ai machines, see [below](#vastai) |
| `ssh` (`servers/ssh.js`) | Run commands and read/write files on remote hosts, see [below](#ssh) |
| `web` (`servers/web.js`) | `web_search`: answers with sources from a NanoGPT `:online` model (a few cents per search) |

Try asking *"What time is it in Tokyo?"*. Servers added to the example in a later version are added to your `mcp-servers.json` once on startup; if you remove one, it stays removed.

## Approving tool calls

With **Ask first** on (the default), any tool that isn't marked read-only (renting, destroying, running a command, writing a file…) shows its exact arguments and waits for you to click **Run** or **Deny**. Read-only tools, like searching offers or checking status, always run straight away. Turn **Ask first** off to let the model work unattended.

A reply can use at most `MAX_TOOL_ROUNDS` rounds of tool calls. After that, the model gets up to 3 more rounds that may only clean up what it started (for example destroy a machine it rented), then it has to answer.

## Vast.ai

Add your API key from https://cloud.vast.ai/manage-keys/ to `.env` (searching works without it):

```bash
VAST_API_KEY=...
```

Then ask, for example:

> Use the vast mcp: rent a cheap instance with a desktop image, download tuxblox on it, wait 10 seconds and then close the vast instance (destroy it).

The model typically calls:
1. `web_search` to find out what [TuxBlox](https://tuxblox.net) is (Roblox Studio on Linux) and how it's installed.
2. `vast_search_templates`, which finds the official *Linux Desktop Container*.
3. `vast_search_offers`.
4. `vast_create_instance`, usually with an `auto_destroy_minutes` safety net.
5. `vast_wait_for_instance`.
6. `vast_exec` with `run_as_user: "user"`, running `curl -sSLf https://tuxblox.net/install.sh | bash`. TuxBlox's installer refuses to run as root, and instances are root by default.
7. `wait`.
8. `vast_destroy_instance`.

Without `web_search`, models that don't know a program invent download URLs. Naming the source in the prompt (e.g. "tuxblox from https://tuxblox.net") works too.

About TuxBlox itself: it's a new, small project whose installer is an unsigned binary. It only *runs* on hosts with Linux kernel 6.7 or newer and a Vulkan driver (`uname -r`, `vulkaninfo --summary`), and Roblox Studio needs you to sign in from the desktop session.

| Tool | What it does |
| --- | --- |
| `vast_search_templates` | Finds ready-made images (desktop, PyTorch, ComfyUI, Ollama…). Only Vast.ai's recommended templates unless `include_community` is set. |
| `vast_search_offers` | Finds machines by GPU, VRAM, price, reliability, country… With `template_hash`, only machines that can run that template. |
| `vast_create_instance` | Rents a machine with a template or Docker image. Billing starts here. Templates without SSH are refused unless `allow_no_ssh` is set, since `vast_exec` can't reach them. |
| `vast_wait_for_instance` | Waits until the machine is running and accepts SSH, reporting progress while the image downloads. Stops early with Vast.ai's error if the image can't be pulled or the container keeps exiting. |
| `vast_exec` | Runs a shell command on the machine, as root or, with `run_as_user`, as a normal user (created if missing) for installers that refuse root. |
| `vast_instance_logs` | Shows the container log. |
| `vast_list_instances`, `vast_get_instance`, `vast_account` | Status, SSH address, price and remaining credit. |
| `vast_start_instance`, `vast_stop_instance`, `vast_reboot_instance`, `vast_destroy_instance` | Lifecycle. Destroying deletes the machine and its data and stops billing. |
| `vast_set_auto_destroy` | Changes or cancels an instance's auto-destroy deadline. |

- The server creates its own SSH key (`.data/vast_ed25519`) and attaches it to each instance it creates, so `vast_exec` works without any SSH setup.
- **Safety nets:** every instance created here is destroyed automatically after `VAST_AUTO_DESTROY_MINUTES` (default 120), even if the model never gets to it. The model can pick another deadline with `auto_destroy_minutes` (0 means never) or change it later with `vast_set_auto_destroy`; set `VAST_AUTO_DESTROY_MINUTES=0` to turn the default off. Deadlines are saved in `.data/`, so one that passed while the app was off runs on the next start, and other copies of the server (say, one you added to Claude Code) share them. If you cancel a reply while a machine is being rented, that machine is destroyed straight away. `VAST_MAX_PRICE_PER_HOUR` refuses offers above that price.
- With a template, the template's own startup script is kept. Run your commands with `vast_exec` after `vast_wait_for_instance`.

## SSH

`servers/ssh.js` provides `ssh_exec`, `ssh_read_file`, `ssh_write_file`, `ssh_list_hosts` and `ssh_public_key`. The model can pass `host` as a hostname, `user@host:port`, or a name from `SSH_HOSTS_FILE`:

```json
{ "gpu": { "host": "203.0.113.7", "port": 22, "username": "root" } }
```

It logs in with `SSH_KEY_PATH` (default `~/.ssh/id_ed25519`, `id_ecdsa` or `id_rsa`), your ssh-agent, or a `password` in the hosts file. Host keys are checked against `~/.ssh/known_hosts`: a changed key is refused, and unknown hosts are accepted unless `SSH_STRICT_HOST_KEY_CHECKING=yes`. `SSH_ALLOWED_HOSTS` (e.g. `*.example.com,10.0.0.*`) limits where the model can connect.

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
- Stdio servers get only a minimal environment (PATH, HOME, …), your proxy and CA-certificate settings (`HTTPS_PROXY`, `NODE_EXTRA_CA_CERTS`, …) so they can reach the internet, and whatever you list in `env`. Your NanoGPT key is not passed to them.
- Tools are offered to the model only when the **MCP tools** switch is on and the selected model supports tool calling. A model can make at most `MAX_TOOL_ROUNDS` rounds of tool calls per reply.

## Using it as an MCP server

`POST /mcp` is a stateless Streamable HTTP MCP endpoint with two tools:

| Tool | What it does |
| --- | --- |
| `chat` | Sends a `prompt` (plus optional `model`, `system`, `temperature`, `use_tools`) to NanoGPT and returns the reply. With `use_tools: true`, the model can also use the read-only tools of the MCP servers configured above (there's nobody to approve the others). |
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
| `MAX_TOOL_ROUNDS` | `20` | Rounds of tool calls in one reply, before the 3 clean-up rounds. |
| `MCP_CONFIG` | `./mcp-servers.json` | Path to the MCP servers file. |
| `NANOGPT_BASE_URL` | `https://nano-gpt.com/api/v1` | API base URL. |
| `VAST_API_KEY` | — | Vast.ai API key for the `vast` server. |
| `VAST_MAX_PRICE_PER_HOUR` | — | Refuse to rent offers above this $/hr. |
| `VAST_AUTO_DESTROY_MINUTES` | `120` | Default auto-destroy deadline for new instances; `0` turns it off. |
| `VAST_SSH_KEY_PATH` | `.data/vast_ed25519` | Key used to reach instances (created if missing). |
| `SSH_KEY_PATH`, `SSH_KEY_PASSPHRASE` | `~/.ssh/id_*` | Key for the `ssh` server. |
| `SSH_HOSTS_FILE` | — | JSON file of named hosts. |
| `SSH_ALLOWED_HOSTS` | any | Comma-separated hostname patterns the model may connect to. |
| `SSH_DEFAULT_USER` | `root` | User when none is given. |
| `SSH_STRICT_HOST_KEY_CHECKING` | — | `yes` refuses hosts that aren't in known_hosts. |
| `WEB_SEARCH_MODEL` | `openai/gpt-5.4-mini:online` | Model used by `web_search` (any NanoGPT model id with `:online`). |

The bundled servers read their settings from `.env` themselves.

## Security

- By default the server listens only on `127.0.0.1` and rejects requests whose `Host` header isn't `localhost`, `127.0.0.1` or `[::1]`, which blocks DNS-rebinding attacks.
- **Set `ACCESS_TOKEN` before using `HOST=0.0.0.0`.** Anyone who can reach the port can spend your NanoGPT credits. A stdio MCP server runs a command on the host, so without a token the UI can't add stdio servers when the host is public.
- MCP tools run with your permissions. Only connect servers you trust, and keep **Ask first** on unless you trust the model with what the tools can do: `ssh_exec` and `vast_exec` run arbitrary commands, and `vast_create_instance` spends money.
- `.env`, `mcp-servers.json`, `ssh-hosts.json` and `.data/` (the Vast SSH key) are git-ignored because they hold secrets.

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
| `POST /api/chat` | `{ model, messages, system?, temperature?, useTools?, servers?, confirmTools? }` returns a Server-Sent Events stream. |
| `POST /api/chat/approve` | `{ runId, id, approved }` answers a tool call that is waiting for approval. |

`/api/chat` sends one JSON event per message: `run` (with the `runId`), `delta` and `reasoning` (text chunks), `assistant_end`, `tool_call` (with `needsApproval`), `tool_progress`, `tool_result`, `notice`, `usage`, `error`, and finally `done`. The `done` event carries `messages`: everything added during the turn (assistant messages, tool calls and tool results) in OpenAI format. Append them to your history for the next request. `confirmTools` defaults to `true`; send `false` to run every tool without asking.

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
servers/vast.js        Vast.ai MCP server
servers/ssh.js         SSH MCP server
servers/web.js         Web search MCP server
servers/lib/           Vast.ai API client, SSH connection pool
examples/              Demo stdio MCP server
test/helpers/          Throwaway SSH server and a mock Vast.ai API used by the tests
```
