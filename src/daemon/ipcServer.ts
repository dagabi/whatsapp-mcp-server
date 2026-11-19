/**
 * Local loopback IPC server. Listens on a Unix domain socket under ./data
 * (not reachable off-host) and additionally requires a random per-run
 * token (./data/daemon.token, mode 0600) on every request as defense in
 * depth.
 *
 * SAFETY INVARIANT: `handlers` below is the complete, closed set of RPC
 * methods this server will ever execute. Every one of them is read-only
 * (it queries SQLite or reports connection status; `sync_now` only flushes
 * WAL / reports counts, it does not talk to WhatsApp). There is no
 * `send_message`, `delete_message`, or similar handler, and the request
 * router (`dispatch`) rejects any method not in this object — so even a
 * malformed or malicious client cannot reach a write capability that does
 * not exist in this process to begin with.
 */
import fs from "node:fs";
import net from "node:net";
import crypto from "node:crypto";
import { SOCKET_PATH, TOKEN_PATH, DATA_DIR } from "../common/paths.js";
import type { IpcMethod, IpcRequest, IpcResponse } from "../common/ipcProtocol.js";
import { getMessages, listChats, searchMessages, countChats, countMessages, db } from "./db.js";
import type { WhatsAppClient } from "./whatsapp.js";

export function ensureToken(): string {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(TOKEN_PATH)) {
    return fs.readFileSync(TOKEN_PATH, "utf8").trim();
  }
  const token = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(TOKEN_PATH, token, { mode: 0o600 });
  return token;
}

type Handler = (params: Record<string, unknown>) => unknown;

function buildHandlers(wa: WhatsAppClient): Record<IpcMethod, Handler> {
  return {
    list_chats: (params) => listChats(typeof params.limit === "number" ? params.limit : undefined),

    get_messages: (params) => {
      const chatId = params.chatId;
      if (typeof chatId !== "string" || !chatId) {
        throw new Error("chatId (string) is required");
      }
      return getMessages({
        chatId,
        limit: typeof params.limit === "number" ? params.limit : undefined,
        before: typeof params.before === "number" ? params.before : null,
        after: typeof params.after === "number" ? params.after : null,
        sinceDate: typeof params.sinceDate === "string" ? params.sinceDate : null,
        untilDate: typeof params.untilDate === "string" ? params.untilDate : null,
      });
    },

    search_messages: (params) => {
      const query = params.query;
      if (typeof query !== "string" || !query.trim()) {
        throw new Error("query (non-empty string) is required");
      }
      return searchMessages({
        query,
        chatId: typeof params.chatId === "string" ? params.chatId : null,
        sender: typeof params.sender === "string" ? params.sender : null,
        limit: typeof params.limit === "number" ? params.limit : undefined,
      });
    },

    link_status: () => wa.getLinkStatus(),

    // Read-only "sync": checkpoints the WAL to disk and reports current
    // totals. Baileys delivers messages continuously via the open
    // WebSocket (messages.upsert / messaging-history.set); there is no
    // on-demand "fetch now" write-capable call involved here.
    sync_now: () => {
      db.pragma("wal_checkpoint(PASSIVE)");
      return {
        triggered: true,
        chatsKnown: countChats(),
        messagesStored: countMessages(),
      };
    },
  };
}

const METHODS: ReadonlySet<string> = new Set<IpcMethod>([
  "list_chats",
  "get_messages",
  "search_messages",
  "link_status",
  "sync_now",
]);

export function startIpcServer(wa: WhatsAppClient): net.Server {
  const token = ensureToken();
  const handlers = buildHandlers(wa);

  if (fs.existsSync(SOCKET_PATH)) {
    fs.rmSync(SOCKET_PATH);
  }

  const server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.trim()) handleLine(socket, line, token, handlers);
      }
    });
    socket.on("error", () => {
      /* client disconnects are not errors we need to log */
    });
  });

  server.listen(SOCKET_PATH, () => {
    fs.chmodSync(SOCKET_PATH, 0o600);
  });

  return server;
}

function handleLine(
  socket: net.Socket,
  line: string,
  token: string,
  handlers: Record<IpcMethod, Handler>
): void {
  let req: IpcRequest;
  try {
    req = JSON.parse(line);
  } catch {
    return; // ignore unparsable input
  }

  const reply = (res: IpcResponse) => socket.write(JSON.stringify(res) + "\n");

  if (!req.id) return;

  if (req.token !== token) {
    reply({ id: req.id, ok: false, error: "unauthorized" });
    return;
  }

  if (!METHODS.has(req.method)) {
    reply({ id: req.id, ok: false, error: `unknown method: ${req.method}` });
    return;
  }

  try {
    const result = handlers[req.method](req.params ?? {});
    reply({ id: req.id, ok: true, result });
  } catch (err) {
    reply({ id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}
