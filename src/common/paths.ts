import path from "node:path";
import { fileURLToPath } from "node:url";

// Repo root = two levels up from src/common/paths.ts (src/common -> src -> root),
// but at runtime this file lives at dist/common/paths.js, so the same relative
// climb (dist/common -> dist -> root) still lands on the repo root.
const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, "..", "..");

export const DATA_DIR = path.join(REPO_ROOT, "data");
export const AUTH_DIR = path.join(DATA_DIR, "auth");
export const DB_PATH = path.join(DATA_DIR, "messages.db");
export const SOCKET_PATH = path.join(DATA_DIR, "daemon.sock");
export const TOKEN_PATH = path.join(DATA_DIR, "daemon.token");
export const DAEMON_PID_PATH = path.join(DATA_DIR, "daemon.pid");
export const DAEMON_LOG_PATH = path.join(DATA_DIR, "daemon.log");

/**
 * IPC transport between the MCP stdio shim and the resident daemon.
 *
 * "unix" (default): same-container deployment, Unix domain socket under
 * ./data, filesystem-permission-gated (mode 0600) plus the token.
 *
 * "tcp": daemon runs in a separate container/host from the MCP shim.
 * Must be bound to an internal-only address (never a public interface) —
 * the token is the only auth, so treat this port like a credential.
 */
export const IPC_MODE: "unix" | "tcp" =
  process.env.WHATSAPP_MCP_IPC_MODE === "tcp" ? "tcp" : "unix";
export const IPC_TCP_HOST = process.env.WHATSAPP_MCP_DAEMON_HOST ?? "127.0.0.1";
export const IPC_TCP_PORT = Number(process.env.WHATSAPP_MCP_DAEMON_PORT ?? 8787);
