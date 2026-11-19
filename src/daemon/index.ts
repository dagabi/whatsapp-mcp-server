import fs from "node:fs";
import { DATA_DIR, DAEMON_PID_PATH } from "../common/paths.js";
import { WhatsAppClient } from "./whatsapp.js";
import { startIpcServer } from "./ipcServer.js";

async function main(): Promise<void> {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DAEMON_PID_PATH, String(process.pid));

  const wa = new WhatsAppClient();
  startIpcServer(wa);
  await wa.start();

  console.log("whatsapp-mcp daemon running (read-only). IPC socket + WhatsApp connection active.");
}

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

main().catch((err) => {
  console.error("Daemon failed to start:", err);
  process.exit(1);
});
