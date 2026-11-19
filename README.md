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
  database, and exposes a read-only RPC API over a Unix domain socket
  (`data/daemon.sock`), guarded by a random per-install token
  (`data/daemon.token`, mode `0600`).
- **MCP shim** (`src/mcp`) — a thin stdio MCP server. Each tool call connects
  to the daemon's Unix socket, issues one read-only RPC call, and returns the
  result. If the daemon isn't running yet, the shim auto-starts it
  (`npm run daemon` equivalent) and waits for the socket to come up.

```
MCP client (Claude, etc.) --stdio--> mcp shim --unix socket + token--> daemon --websocket--> WhatsApp
                                                                           |
                                                                           v
                                                                   SQLite (data/messages.db)
```

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
