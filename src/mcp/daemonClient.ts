/**
 * Thin client used by the MCP stdio shim to talk to the resident daemon
 * over the local Unix socket, auto-starting the daemon if it isn't already
 * running. This file only ever issues the read-only IPC methods defined in
 * ../common/ipcProtocol.ts — see that file and ipcServer.ts for the
 * no-send invariant.
 */
import fs from "node:fs";
import net from "node:net";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DATA_DIR,
  SOCKET_PATH,
  TOKEN_PATH,
  DAEMON_LOG_PATH,
  REPO_ROOT,
} from "../common/paths.js";
import type { IpcMethod, IpcRequest, IpcResponse } from "../common/ipcProtocol.js";

const here = path.dirname(fileURLToPath(import.meta.url));

function readToken(): string | null {
  try {
    return fs.readFileSync(TOKEN_PATH, "utf8").trim();
  } catch {
    return null;
  }
}

async function socketIsAlive(): Promise<boolean> {
  if (!fs.existsSync(SOCKET_PATH)) return false;
  return new Promise((resolve) => {
    const sock = net.createConnection(SOCKET_PATH);
    sock.once("connect", () => {
      sock.end();
      resolve(true);
    });
    sock.once("error", () => resolve(false));
    setTimeout(() => {
      sock.destroy();
      resolve(false);
    }, 500);
  });
}

function spawnDaemon(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const daemonEntry = path.resolve(here, "..", "daemon", "index.js");
  const logFd = fs.openSync(DAEMON_LOG_PATH, "a");
  const child = spawn(process.execPath, [daemonEntry], {
    cwd: REPO_ROOT,
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
}

async function waitForSocket(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await socketIsAlive()) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

export async function ensureDaemonRunning(): Promise<void> {
  if (await socketIsAlive()) return;
  spawnDaemon();
  const ok = await waitForSocket(15_000);
  if (!ok) {
    throw new Error(
      "Timed out waiting for whatsapp-mcp daemon to start. Check data/daemon.log."
    );
  }
}

export async function callDaemon<T = unknown>(
  method: IpcMethod,
  params: Record<string, unknown> = {}
): Promise<T> {
  await ensureDaemonRunning();
  const token = readToken();
  if (!token) {
    throw new Error("Daemon has no auth token yet (data/daemon.token missing). Try again shortly.");
  }

  return new Promise<T>((resolve, reject) => {
    const sock = net.createConnection(SOCKET_PATH);
    const id = crypto.randomUUID();
    let buffer = "";

    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error("Timed out waiting for daemon response"));
    }, 10_000);

    sock.on("connect", () => {
      const req: IpcRequest = { id, token, method, params };
      sock.write(JSON.stringify(req) + "\n");
    });

    sock.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const idx = buffer.indexOf("\n");
      if (idx === -1) return;
      const line = buffer.slice(0, idx);
      clearTimeout(timer);
      sock.end();
      try {
        const res: IpcResponse = JSON.parse(line);
        if (res.id !== id) {
          reject(new Error("Mismatched response id from daemon"));
        } else if (res.ok) {
          resolve(res.result as T);
        } else {
          reject(new Error(res.error));
        }
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });

    sock.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
