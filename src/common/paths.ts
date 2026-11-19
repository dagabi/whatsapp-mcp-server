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
