/**
 * WhatsApp connection via Baileys.
 *
 * SAFETY INVARIANT: this module only ever calls read-side Baileys APIs
 * (connecting, listening to events, and `fetchMessageHistory` for backfill).
 * It must never call `sock.sendMessage`, `sock.sendPresenceUpdate` with
 * writes, `sock.readMessages` (receipts), reaction/edit/delete APIs, or any
 * other method that mutates WhatsApp state. Do not add such a call here or
 * anywhere else in this codebase — see README.md "No-send guarantee".
 */
import fs from "node:fs";
import path from "node:path";
import {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  type WASocket,
  type WAMessage,
  type Chat,
  type Contact,
} from "baileys";
import { Boom } from "@hapi/boom";
import qrcodeTerminal from "qrcode-terminal";
import QRCode from "qrcode";
import pino from "pino";
import { AUTH_DIR, DATA_DIR } from "../common/paths.js";
import { insertMessage, upsertChat } from "./db.js";
import type { LinkStatus } from "../common/ipcProtocol.js";

const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });

export class WhatsAppClient {
  private sock: WASocket | null = null;
  private state: LinkStatus["state"] = "unknown";
  private qrPending = false;
  private lastConnectedAt: number | null = null;
  private selfJid: string | null = null;
  private contactNames = new Map<string, string>();
  private starting = false;

  async start(): Promise<void> {
    if (this.starting) return;
    this.starting = true;
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    await this.connect();
  }

  private async connect(): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    // The library's baked-in default WA Web version goes stale as WhatsApp
    // rolls out server-side changes, and pairing against a stale version is
    // a common cause of "Couldn't link device, try again later" even when
    // the QR scan itself succeeds. Always fetch the current version instead
    // of relying on the package default.
    const { version, isLatest } = await fetchLatestBaileysVersion();
    logger.info({ version, isLatest }, "Using WA Web version");

    const sock = makeWASocket({
      auth: state,
      version,
      logger: logger.child({ mod: "baileys" }),
      // Read-only: we intentionally do not set markOnlineOnConnect behavior
      // beyond the library default, and we never mark chats/messages as
      // read (no receipt calls are made anywhere in this codebase).
      syncFullHistory: false,
    });
    this.sock = sock;
    this.state = "connecting";

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        this.qrPending = true;
        console.log("\nScan this QR code from WhatsApp > Linked Devices > Link a Device:\n");
        qrcodeTerminal.generate(qr, { small: true });
        const qrPngPath = path.join(DATA_DIR, "latest-qr.png");
        QRCode.toFile(qrPngPath, qr, { width: 512 }).catch((err) => {
          logger.warn({ err }, "Failed to write QR PNG");
        });
      }

      if (connection === "open") {
        this.state = "open";
        this.qrPending = false;
        this.lastConnectedAt = Date.now();
        this.selfJid = sock.user?.id ?? null;
        logger.info("WhatsApp connection open");
      } else if (connection === "close") {
        this.state = "close";
        const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        if (loggedOut) {
          this.state = "logged_out";
          logger.warn("Logged out. Delete data/auth and re-run to pair again.");
        } else {
          logger.warn({ statusCode }, "Connection closed, reconnecting...");
          this.starting = false;
          setTimeout(() => {
            this.start().catch((err) => logger.error({ err }, "Reconnect failed"));
          }, 2000);
        }
      }
    });

    sock.ev.on("messaging-history.set", ({ chats, contacts, messages }) => {
      for (const c of contacts) this.rememberContact(c);
      for (const c of chats) this.storeChatMeta(c);
      for (const m of messages) this.storeMessage(m);
      logger.info(
        { chats: chats.length, messages: messages.length },
        "Ingested history sync batch"
      );
    });

    sock.ev.on("chats.upsert", (chats) => {
      for (const c of chats) this.storeChatMeta(c);
    });

    sock.ev.on("chats.update", (updates) => {
      for (const u of updates) this.storeChatMeta(u as Chat);
    });

    sock.ev.on("contacts.upsert", (contacts) => {
      for (const c of contacts) this.rememberContact(c);
    });

    sock.ev.on("contacts.update", (contacts) => {
      for (const c of contacts) this.rememberContact(c as Contact);
    });

    sock.ev.on("messages.upsert", ({ messages }) => {
      for (const m of messages) this.storeMessage(m);
    });
  }

  private rememberContact(c: Partial<Contact>): void {
    if (c.id && (c.name || c.notify)) {
      this.contactNames.set(c.id, c.name ?? c.notify ?? c.id);
    }
  }

  private storeChatMeta(c: Partial<Chat>): void {
    if (!c.id) return;
    upsertChat({
      id: c.id,
      name: c.name ?? this.contactNames.get(c.id) ?? null,
      isGroup: c.id.endsWith("@g.us"),
      lastMessageTs: typeof c.conversationTimestamp === "number" ? c.conversationTimestamp : null,
    });
  }

  private storeMessage(m: WAMessage): void {
    if (!m.key?.remoteJid || !m.key?.id) return;
    // protocolMessage covers Baileys-internal signaling (history-sync
    // notifications, app-state key shares, etc.) addressed to our own JID.
    // It is never user-visible chat content, so storing it only pollutes
    // the message store with empty-text, fromMe entries at connect time.
    if (m.message?.protocolMessage) return;
    const chatId = m.key.remoteJid;
    const text = extractText(m);
    const timestamp = toUnixSeconds(m.messageTimestamp);
    const sender = m.key.fromMe ? this.selfJid : m.key.participant ?? chatId;
    const senderName = sender ? this.contactNames.get(sender) ?? null : null;

    // Ensure the chat row exists even if we haven't seen chat metadata yet.
    upsertChat({
      id: chatId,
      name: this.contactNames.get(chatId) ?? null,
      isGroup: chatId.endsWith("@g.us"),
      lastMessageTs: timestamp,
    });

    insertMessage({
      id: m.key.id,
      chatId,
      sender,
      senderName,
      fromMe: !!m.key.fromMe,
      timestamp,
      text,
    });
  }

  getLinkStatus(): LinkStatus {
    return {
      connected: this.state === "open",
      state: this.state,
      qrPending: this.qrPending,
      lastConnectedAt: this.lastConnectedAt,
      selfJid: this.selfJid,
    };
  }
}

function toUnixSeconds(ts: unknown): number {
  if (typeof ts === "number") return ts;
  if (typeof ts === "string") return parseInt(ts, 10);
  if (ts && typeof ts === "object" && "toNumber" in (ts as any)) {
    return (ts as any).toNumber();
  }
  return Math.floor(Date.now() / 1000);
}

function extractText(m: WAMessage): string | null {
  const msg = m.message;
  if (!msg) return null;
  return (
    msg.conversation ??
    msg.extendedTextMessage?.text ??
    msg.imageMessage?.caption ??
    msg.videoMessage?.caption ??
    msg.documentMessage?.caption ??
    msg.documentWithCaptionMessage?.message?.documentMessage?.caption ??
    (msg.buttonsResponseMessage?.selectedDisplayText ?? null) ??
    (msg.listResponseMessage?.title ?? null) ??
    null
  );
}
