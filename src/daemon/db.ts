import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { DATA_DIR, DB_PATH } from "../common/paths.js";
import type { ChatSummary, StoredMessage } from "../common/ipcProtocol.js";

fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS chats (
    id TEXT PRIMARY KEY,
    name TEXT,
    is_group INTEGER NOT NULL DEFAULT 0,
    last_message_ts INTEGER
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    sender TEXT,
    sender_name TEXT,
    from_me INTEGER NOT NULL DEFAULT 0,
    timestamp INTEGER NOT NULL,
    text TEXT,
    FOREIGN KEY (chat_id) REFERENCES chats(id)
  );

  CREATE TABLE IF NOT EXISTS contacts (
    jid TEXT PRIMARY KEY,
    name TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_messages_chat_ts ON messages (chat_id, timestamp);
  CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages (timestamp);

  CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5 (
    text,
    content='messages',
    content_rowid='rowid'
  );

  CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
  END;

  CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, text) VALUES('delete', old.rowid, old.text);
  END;

  CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, text) VALUES('delete', old.rowid, old.text);
    INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
  END;
`);

// --- Ingest (daemon-internal only; not exposed over IPC) ---------------

const upsertChatStmt = db.prepare(`
  INSERT INTO chats (id, name, is_group, last_message_ts)
  VALUES (@id, @name, @isGroup, @lastMessageTs)
  ON CONFLICT(id) DO UPDATE SET
    name = COALESCE(excluded.name, chats.name),
    is_group = excluded.is_group,
    last_message_ts = MAX(COALESCE(chats.last_message_ts, 0), COALESCE(excluded.last_message_ts, 0))
`);

export function upsertChat(input: {
  id: string;
  name: string | null;
  isGroup: boolean;
  lastMessageTs?: number | null;
}): void {
  upsertChatStmt.run({
    id: input.id,
    name: input.name,
    isGroup: input.isGroup ? 1 : 0,
    lastMessageTs: input.lastMessageTs ?? null,
  });
}

const upsertContactStmt = db.prepare(`
  INSERT INTO contacts (jid, name) VALUES (@jid, @name)
  ON CONFLICT(jid) DO UPDATE SET name = excluded.name
`);

/** Remember a display name for a JID (phone-number JID or @lid alike). */
export function upsertContact(jid: string, name: string): void {
  upsertContactStmt.run({ jid, name });
}

const insertMessageStmt = db.prepare(`
  INSERT INTO messages (id, chat_id, sender, sender_name, from_me, timestamp, text)
  VALUES (@id, @chatId, @sender, @senderName, @fromMe, @timestamp, @text)
  ON CONFLICT(id) DO NOTHING
`);

const bumpChatLastMessageStmt = db.prepare(`
  UPDATE chats SET last_message_ts = MAX(COALESCE(last_message_ts, 0), @ts) WHERE id = @chatId
`);

export function insertMessage(input: {
  id: string;
  chatId: string;
  sender: string | null;
  senderName: string | null;
  fromMe: boolean;
  timestamp: number;
  text: string | null;
}): void {
  insertMessageStmt.run({
    id: input.id,
    chatId: input.chatId,
    sender: input.sender,
    senderName: input.senderName,
    fromMe: input.fromMe ? 1 : 0,
    timestamp: input.timestamp,
    text: input.text,
  });
  bumpChatLastMessageStmt.run({ chatId: input.chatId, ts: input.timestamp });
}

export function countChats(): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM chats`).get() as { n: number }).n;
}

export function countMessages(): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM messages`).get() as { n: number }).n;
}

// --- Read-only query helpers (used by IPC handlers) ---------------------

export function listChats(limit = 200): ChatSummary[] {
  const rows = db
    .prepare(
      `SELECT c.id AS id, COALESCE(ct.name, c.name) AS name, c.is_group AS isGroup,
              c.last_message_ts AS lastMessageTimestamp
       FROM chats c
       LEFT JOIN contacts ct ON ct.jid = c.id
       ORDER BY COALESCE(c.last_message_ts, 0) DESC
       LIMIT @limit`
    )
    .all({ limit }) as Array<{
    id: string;
    name: string | null;
    isGroup: number;
    lastMessageTimestamp: number | null;
  }>;

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    isGroup: !!r.isGroup,
    lastMessageTimestamp: r.lastMessageTimestamp,
  }));
}

function rowToMessage(r: any): StoredMessage {
  return {
    id: r.id,
    chatId: r.chatId,
    chatName: r.chatName,
    sender: r.sender,
    senderName: r.senderName,
    fromMe: !!r.fromMe,
    timestamp: r.timestamp,
    text: r.text,
  };
}

export function getMessages(params: {
  chatId: string;
  limit?: number;
  before?: number | null;
  after?: number | null;
  sinceDate?: string | null;
  untilDate?: string | null;
}): StoredMessage[] {
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 500);
  const clauses: string[] = ["m.chat_id = @chatId"];
  const bind: Record<string, unknown> = { chatId: params.chatId, limit };

  if (params.before != null) {
    clauses.push("m.timestamp < @before");
    bind.before = params.before;
  }
  if (params.after != null) {
    clauses.push("m.timestamp > @after");
    bind.after = params.after;
  }
  if (params.sinceDate) {
    bind.sinceTs = Math.floor(new Date(params.sinceDate).getTime() / 1000);
    clauses.push("m.timestamp >= @sinceTs");
  }
  if (params.untilDate) {
    bind.untilTs = Math.floor(new Date(params.untilDate).getTime() / 1000);
    clauses.push("m.timestamp <= @untilTs");
  }

  const sql = `
    SELECT m.id AS id, m.chat_id AS chatId, COALESCE(cct.name, c.name) AS chatName, m.sender AS sender,
           COALESCE(sct.name, m.sender_name) AS senderName, m.from_me AS fromMe, m.timestamp AS timestamp, m.text AS text
    FROM messages m
    LEFT JOIN chats c ON c.id = m.chat_id
    LEFT JOIN contacts cct ON cct.jid = m.chat_id
    LEFT JOIN contacts sct ON sct.jid = m.sender
    WHERE ${clauses.join(" AND ")}
    ORDER BY m.timestamp DESC
    LIMIT @limit
  `;

  const rows = db.prepare(sql).all(bind) as any[];
  return rows.map(rowToMessage);
}

export function searchMessages(params: {
  query: string;
  chatId?: string | null;
  sender?: string | null;
  limit?: number;
}): StoredMessage[] {
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 500);

  const ftsClauses: string[] = ["messages_fts MATCH @query"];
  const ftsBind: Record<string, unknown> = { query: sanitizeFtsQuery(params.query), limit };
  applyFilters(ftsClauses, ftsBind, params);

  const ftsSql = `
    SELECT m.id AS id, m.chat_id AS chatId, COALESCE(cct.name, c.name) AS chatName, m.sender AS sender,
           COALESCE(sct.name, m.sender_name) AS senderName, m.from_me AS fromMe, m.timestamp AS timestamp, m.text AS text
    FROM messages_fts
    JOIN messages m ON m.rowid = messages_fts.rowid
    LEFT JOIN chats c ON c.id = m.chat_id
    LEFT JOIN contacts cct ON cct.jid = m.chat_id
    LEFT JOIN contacts sct ON sct.jid = m.sender
    WHERE ${ftsClauses.join(" AND ")}
    ORDER BY m.timestamp DESC
    LIMIT @limit
  `;

  const rows = db.prepare(ftsSql).all(ftsBind) as any[];
  if (rows.length > 0) return rows.map(rowToMessage);

  // FTS5's default tokenizer does exact-token matching: it has no concept of
  // Hebrew prefixes (ה-/ו-/ב-/ל-/מ-) or verb conjugation, so a query like
  // "עץ" or "לכרות" will not match text containing "העץ" or "שכרת". Fall
  // back to a plain substring scan so those common misses still surface.
  const likeClauses: string[] = ["m.text LIKE @likeQuery"];
  const likeBind: Record<string, unknown> = { likeQuery: `%${params.query.trim()}%`, limit };
  applyFilters(likeClauses, likeBind, params);

  const likeSql = `
    SELECT m.id AS id, m.chat_id AS chatId, COALESCE(cct.name, c.name) AS chatName, m.sender AS sender,
           COALESCE(sct.name, m.sender_name) AS senderName, m.from_me AS fromMe, m.timestamp AS timestamp, m.text AS text
    FROM messages m
    LEFT JOIN chats c ON c.id = m.chat_id
    LEFT JOIN contacts cct ON cct.jid = m.chat_id
    LEFT JOIN contacts sct ON sct.jid = m.sender
    WHERE ${likeClauses.join(" AND ")}
    ORDER BY m.timestamp DESC
    LIMIT @limit
  `;

  const likeRows = db.prepare(likeSql).all(likeBind) as any[];
  return likeRows.map(rowToMessage);
}

function applyFilters(
  clauses: string[],
  bind: Record<string, unknown>,
  params: { chatId?: string | null; sender?: string | null }
): void {
  if (params.chatId) {
    clauses.push("m.chat_id = @chatId");
    bind.chatId = params.chatId;
  }
  if (params.sender) {
    clauses.push("(m.sender = @sender OR m.sender_name LIKE @senderLike)");
    bind.sender = params.sender;
    bind.senderLike = `%${params.sender}%`;
  }
}

// FTS5 query syntax treats certain characters specially; quote the whole
// phrase per token to let users search arbitrary free text safely.
function sanitizeFtsQuery(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '""';
  const tokens = trimmed.split(/\s+/).map((t) => `"${t.replace(/"/g, '""')}"`);
  return tokens.join(" ");
}
