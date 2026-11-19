/**
 * Local loopback IPC protocol between the MCP stdio shim (client) and the
 * resident daemon (server), over a Unix domain socket.
 *
 * IMPORTANT (safety invariant): the set of method names below is a closed,
 * exhaustive allow-list. Every method here is read-only. There is
 * intentionally no method, parameter, or code path anywhere in this protocol
 * that can send, edit, delete, react to, or otherwise write a WhatsApp
 * message. Do not add one. See README.md "No-send guarantee".
 */

export type IpcMethod =
  | "list_chats"
  | "get_messages"
  | "search_messages"
  | "link_status"
  | "sync_now";

export interface IpcRequest {
  id: string;
  token: string;
  method: IpcMethod;
  params: Record<string, unknown>;
}

export interface IpcSuccessResponse {
  id: string;
  ok: true;
  result: unknown;
}

export interface IpcErrorResponse {
  id: string;
  ok: false;
  error: string;
}

export type IpcResponse = IpcSuccessResponse | IpcErrorResponse;

export interface ChatSummary {
  id: string;
  name: string | null;
  isGroup: boolean;
  lastMessageTimestamp: number | null;
}

export interface StoredMessage {
  id: string;
  chatId: string;
  chatName: string | null;
  sender: string | null;
  senderName: string | null;
  fromMe: boolean;
  timestamp: number;
  text: string | null;
}

export interface LinkStatus {
  connected: boolean;
  state: "connecting" | "open" | "close" | "logged_out" | "unknown";
  qrPending: boolean;
  lastConnectedAt: number | null;
  selfJid: string | null;
}

export interface SyncResult {
  triggered: boolean;
  chatsKnown: number;
  messagesStored: number;
}
