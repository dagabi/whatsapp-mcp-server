# whatsapp-mcp (read-only)

A local MCP (Model Context Protocol) server that lets an AI agent **search and
read** your own WhatsApp message history. It cannot send, delete, edit,
react to, or otherwise modify anything on WhatsApp.

## No-send guarantee

This is a structural guarantee, not a prompt-level restriction:

- The only Baileys (WhatsApp protocol library) calls made anywhere in this
  codebase are `makeWASocket(...)`, `sock.ev.on(...)` (subscribing to
  incoming events), and reading `sock.user`. See
  [`src/daemon/whatsapp.ts`](src/daemon/whatsapp.ts).
- There is no call to `sock.sendMessage`, `sendPresenceUpdate`,
  `readMessages`/receipts, reactions, edits, deletes, group mutations, or any
  other write-capable Baileys method, anywhere in `src/`. Nothing imports or
  wires up such a call.
- The MCP server exposes **exactly five tools** (`list_chats`,
  `get_messages`, `search_messages`, `link_status`, `sync_now`), all of
  which only read from the local SQLite database or report connection
  status. See [`src/mcp/index.ts`](src/mcp/index.ts).
- The local IPC protocol between the MCP shim and the daemon
  ([`src/common/ipcProtocol.ts`](src/common/ipcProtocol.ts) and
  [`src/daemon/ipcServer.ts`](src/daemon/ipcServer.ts)) is a closed
  allow-list of the same five read-only methods; the server rejects any
  other method name outright.

Because the capability doesn't exist in the code at all, no prompt, tool
description, or malicious MCP client input can make this server send a
WhatsApp message. You can verify this yourself at any time:

```bash
grep -rniE "sendMessage|sendReaction|deleteMessage|chatModify|groupAdd|relayMessage" src/
```

This should only ever match comments describing the invariant, never a
function call.

## Architecture

WhatsApp (via Baileys) requires a persistent WebSocket connection to receive
messages, but MCP clients spawn the MCP server on demand over stdio. So this
project is split into two processes:

- **Daemon** (`src/daemon`) — a long-running resident process that holds the
  Baileys WebSocket connection, writes incoming messages to a local SQLite
  database, and exposes a read-only RPC API over IPC (Unix domain socket or
  TCP, see below), guarded by a random per-install token
  (`data/daemon.token`, mode `0600`).
- **MCP shim** (`src/mcp`) — a thin stdio MCP server. Each tool call connects
  to the daemon over IPC, issues one read-only RPC call, and returns the
  result. In the default same-container setup the shim auto-starts the
  daemon (`npm run daemon` equivalent) if it isn't already running and waits
  for the socket to come up.

```
MCP client (Claude, etc.) --stdio--> mcp shim --ipc + token--> daemon --websocket--> WhatsApp
                                                                   |
                                                                   v
                                                           SQLite (data/messages.db)
```

### IPC transport modes

By default the daemon and the MCP shim run in the same container and talk
over a Unix domain socket (`data/daemon.sock`, mode `0600`). They can instead
run in **separate containers**, with the MCP shim reaching the daemon over
TCP:

| Env var | Where | Purpose |
| --- | --- | --- |
| `WHATSAPP_MCP_IPC_MODE` | both | `"unix"` (default) or `"tcp"`. |
| `WHATSAPP_MCP_DAEMON_HOST` | both (tcp mode) | Host the daemon binds/the shim connects to. Must be an internal-only address (loopback or a private/docker-internal IP) — never a public interface. |
| `WHATSAPP_MCP_DAEMON_PORT` | both (tcp mode) | Port (default `8787`). |
| `WHATSAPP_MCP_DAEMON_TOKEN` | shim (tcp mode) | The daemon's auth token, injected directly since `data/daemon.token` won't be on the shim's filesystem in this mode. Read it from the daemon container's `data/daemon.token` and pass it as an env var when registering the MCP server. |

In TCP mode the shim will not try to spawn the daemon itself (there's
nowhere local to spawn it) — it fails with a clear error if the daemon isn't
reachable, instead of auto-starting one. The auth token is the only guard on
this port (no transport encryption), so treat it like a credential and keep
it bound to an internal-only address.

### MCP client transport modes

By default an MCP client spawns this project's MCP server as a local child
process and talks to it over stdio — this only works when the client and
server run in the same container. To run the MCP server in its own
container (separate from the agent container that calls it), switch it to
an HTTP transport instead:

| Env var | Where | Purpose |
| --- | --- | --- |
| `WHATSAPP_MCP_TRANSPORT` | mcp server | `"stdio"` (default) or `"http"`. |
| `WHATSAPP_MCP_HTTP_PORT` | mcp server (http mode) | Port to listen on (default `8788`). Bound on `0.0.0.0` — this is expected; see below. |
| `WHATSAPP_MCP_HTTP_TOKEN` | mcp server (http mode) | Required bearer token. The server refuses to start in http mode without it. |

In http mode, every request must send `Authorization: Bearer <token>`; a
missing or wrong token gets a 401. This token is the *only* access control
on this port — once this process listens on a network port instead of
being spawned locally, anyone who can reach it could otherwise call
`list_chats`/`search_messages`/`get_messages` and read the owner's WhatsApp
message history with no auth at all (still read-only — no send capability
exists — but it would leak message contents to anyone on the network
path). Treat `WHATSAPP_MCP_HTTP_TOKEN` like a credential, the same way as
`WHATSAPP_MCP_DAEMON_TOKEN` above — they guard two different links and are
not interchangeable. Binding on `0.0.0.0` is fine here: this port's whole
job is to be reached from another container, and actual network exposure
is controlled by the `docker run`/compose port mapping, not by the bind
address.

## Setup

```bash
npm install
npm run build
```

### First-run pairing (do this once)

1. Start the daemon directly so you can see the QR code:
   ```bash
   npm run daemon
   ```
2. A QR code will print in the terminal. Open WhatsApp on your phone →
   **Settings/Linked devices → Link a device**, and scan it.
3. Once linked, the daemon logs that the connection is open and begins
   syncing chat/message history into `data/messages.db`. The session is
   persisted under `data/auth/` (gitignored) so you won't need to re-scan on
   future restarts — just run `npm run daemon` again.
4. Leave the daemon running in the background (e.g. under `systemd`, `pm2`,
   `tmux`, or similar) so it stays connected and keeps syncing. The MCP shim
   will also auto-start it if it finds it isn't running, but a message can
   only be searched after it has synced in while the daemon was connected.

### Registering as a local MCP server

Point your MCP client at the compiled shim's stdio entrypoint:

- **Command**: `node`
- **Args**: `["/absolute/path/to/whatsapp-mcp/dist/mcp/index.js"]`

Example config block (adjust to your client's config format):

```json
{
  "mcpServers": {
    "whatsapp": {
      "command": "node",
      "args": ["/absolute/path/to/whatsapp-mcp/dist/mcp/index.js"]
    }
  }
}
```

The shim will auto-start the daemon on first tool call if it isn't already
running.

## Running in Docker

A single multi-stage `Dockerfile` at the repo root builds both processes;
which one runs is just which command you launch the container with. Build
once, run it twice with different commands/env:

```bash
docker build -t whatsapp-mcp .

# A private user-defined network so the two containers can reach each
# other by name without publishing the daemon's IPC port to the host.
docker network create whatsapp-net

# Daemon container — holds the WhatsApp connection, owns data/.
docker run -d --name whatsapp-daemon \
  --network whatsapp-net \
  -v "$(pwd)/data:/app/data" \
  -e WHATSAPP_MCP_IPC_MODE=tcp \
  -e WHATSAPP_MCP_DAEMON_HOST=0.0.0.0 \
  whatsapp-mcp
  # CMD defaults to: node dist/daemon/index.js
  # WHATSAPP_MCP_DAEMON_HOST=0.0.0.0 makes the daemon log its usual
  # "binds every interface" warning (see ipcServer.ts) — expected here:
  # no -p was passed, so the port isn't reachable off whatsapp-net at all,
  # and the per-request token still guards it either way.

# MCP-server container — separate container, talks to the daemon over TCP
# and to its own MCP client over HTTP.
docker run -d --name whatsapp-mcp-server \
  --network whatsapp-net \
  -p 8788:8788 \
  -e WHATSAPP_MCP_IPC_MODE=tcp \
  -e WHATSAPP_MCP_DAEMON_HOST=whatsapp-daemon \
  -e WHATSAPP_MCP_DAEMON_PORT=8787 \
  -e WHATSAPP_MCP_DAEMON_TOKEN="$(cat data/daemon.token)" \
  -e WHATSAPP_MCP_TRANSPORT=http \
  -e WHATSAPP_MCP_HTTP_TOKEN=<choose-a-token> \
  whatsapp-mcp node dist/mcp/index.js
  # overrides CMD to run the mcp shim instead of the daemon
```

Notes:

- `data/` (auth session, `messages.db`, `daemon.token`) must be a mounted
  volume — the image never bakes it in (it's gitignored and
  dockerignored). Only the daemon container needs it mounted; the
  mcp-server container reaches the daemon over the network and never
  touches the filesystem under `data/`.
- Put the agent container that calls the mcp-server on `whatsapp-net` too
  (or any network that can reach it) so it can register this as a remote
  MCP server at `http://whatsapp-mcp-server:8788` with the
  `WHATSAPP_MCP_HTTP_TOKEN` value as its bearer token. The `-p 8788:8788`
  above is only needed if something outside Docker needs to reach it.
- See "IPC transport modes" above for the daemon-link env vars
  (`WHATSAPP_MCP_IPC_MODE`, `WHATSAPP_MCP_DAEMON_HOST`/`PORT`/`TOKEN`) and
  "MCP client transport modes" above for the mcp-server's own HTTP env
  vars (`WHATSAPP_MCP_TRANSPORT`, `WHATSAPP_MCP_HTTP_PORT`,
  `WHATSAPP_MCP_HTTP_TOKEN`).
- First-run pairing (the QR code step) still needs to happen against the
  daemon container's logs — run `docker logs -f whatsapp-daemon` after
  starting it the first time.

## Tools

| Tool | Description |
| --- | --- |
| `list_chats` | List known chats (id, name, group flag, last message time). |
| `get_messages` | Get messages from one chat, newest first, with pagination / date range. |
| `search_messages` | Full-text search across all stored messages, optionally filtered by chat and/or sender. |
| `link_status` | Report whether the daemon is paired/connected, and whether a QR pairing is pending. |
| `sync_now` | Flush/checkpoint the local database and report current chat/message counts. |

There is no sixth tool, and none of these accept parameters that reach a
write-capable code path.

## Data storage

Messages are stored in `data/messages.db` (SQLite, with an FTS5 index for
search). `data/`, `node_modules/`, and `dist/` are all gitignored — nothing
under `data/` (session credentials, message history, auth token) is ever
committed.

## Why no send capability

This server backs a personal assistant agent that needs to answer questions
like "find the message where X mentioned Y." The owner explicitly requires
that it be structurally impossible for the agent (or anyone prompting it) to
send, delete, or edit a WhatsApp message through this tool — not just
discouraged by instructions. Keeping the send code path entirely absent from
the codebase is what makes that guarantee hold regardless of what any LLM
decides to do.

## License

MIT — see [LICENSE](LICENSE). This is original code; it depends on the
MIT-licensed `baileys` library but does not reuse code from any other
WhatsApp MCP project.
