/**
 * MCP server — the only surface an MCP client ever talks to.
 *
 * SAFETY INVARIANT: this file registers exactly five tools, all read-only
 * (list_chats, get_messages, search_messages, link_status, sync_now). Each
 * handler does nothing but call `callDaemon(...)`, which can only invoke
 * the closed, read-only method set in ../common/ipcProtocol.ts. There is no
 * sixth tool, and none of these five accepts parameters that could be used
 * to send, edit, delete, or react to a WhatsApp message — those
 * capabilities do not exist anywhere in this codebase. See README.md. This
 * invariant holds the same way regardless of transport (stdio or http,
 * below) — the transport only decides how bytes reach this process, not
 * what either side is allowed to ask of it.
 */
import crypto from "node:crypto";
import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { callDaemon } from "./daemonClient.js";
import { MCP_TRANSPORT, MCP_HTTP_PORT, MCP_HTTP_TOKEN } from "../common/paths.js";

function textResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function errorResult(err: unknown) {
  return {
    isError: true,
    content: [
      { type: "text" as const, text: err instanceof Error ? err.message : String(err) },
    ],
  };
}

function registerTools(server: McpServer): void {
  server.registerTool(
    "list_chats",
    {
      description:
        "List known WhatsApp chats/conversations (id, name, whether it's a group, last message time). Read-only.",
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe("Max number of chats to return (default 200)."),
      },
    },
    async ({ limit }) => {
      try {
        const chats = await callDaemon("list_chats", { limit });
        return textResult(chats);
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "get_messages",
    {
      description:
        "Get stored messages from a specific chat, newest first, with pagination and optional date range. Read-only.",
      inputSchema: {
        chatId: z.string().describe("The WhatsApp chat id (e.g. '123456789@s.whatsapp.net' or '...@g.us')."),
        limit: z.number().int().min(1).max(500).optional().describe("Max messages to return (default 50)."),
        before: z
          .number()
          .int()
          .optional()
          .describe("Only return messages with a unix timestamp strictly before this value (for pagination)."),
        after: z
          .number()
          .int()
          .optional()
          .describe("Only return messages with a unix timestamp strictly after this value."),
        sinceDate: z.string().optional().describe("ISO date/time lower bound, inclusive."),
        untilDate: z.string().optional().describe("ISO date/time upper bound, inclusive."),
      },
    },
    async (args) => {
      try {
        const messages = await callDaemon("get_messages", args);
        return textResult(messages);
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "search_messages",
    {
      description:
        "Full-text search across all stored messages, optionally filtered by chat and/or sender. Read-only.",
      inputSchema: {
        query: z.string().min(1).describe("Search text (full-text match over message content)."),
        chatId: z.string().optional().describe("Restrict results to this chat id."),
        sender: z
          .string()
          .optional()
          .describe("Restrict results to this sender (jid exact match, or substring of sender display name)."),
        limit: z.number().int().min(1).max(500).optional().describe("Max results to return (default 50)."),
      },
    },
    async (args) => {
      try {
        const results = await callDaemon("search_messages", args);
        return textResult(results);
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "link_status",
    {
      description:
        "Report whether the daemon is currently paired/connected to WhatsApp, and whether a QR pairing is pending. Read-only.",
      inputSchema: {},
    },
    async () => {
      try {
        const status = await callDaemon("link_status", {});
        return textResult(status);
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "sync_now",
    {
      description:
        "Trigger an on-demand local flush/checkpoint of the message store and report current chat/message counts. Does not contact WhatsApp on demand (the daemon maintains a persistent connection already); this only flushes buffered local writes. Read-only with respect to WhatsApp.",
      inputSchema: {},
    },
    async () => {
      try {
        const result = await callDaemon("sync_now", {});
        return textResult(result);
      } catch (err) {
        return errorResult(err);
      }
    }
  );
}

// Built fresh wherever a server instance is needed. The Streamable HTTP
// transport (see runHttp below) requires a new transport object per
// request in stateless mode, and pairing each with its own McpServer
// avoids one request's response ever being routed through another
// request's transport. Tool registration (and the SAFETY INVARIANT above)
// is identical regardless of transport.
function createServer(): McpServer {
  const server = new McpServer({
    name: "whatsapp-mcp",
    version: "0.1.0",
  });
  registerTools(server);
  return server;
}

function sendJsonRpcError(res: http.ServerResponse, status: number, code: number, message: string): void {
  res.writeHead(status, { "Content-Type": "application/json" }).end(
    JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null })
  );
}

// This check is the *only* access control on the HTTP transport: unlike
// stdio (where the client is a local parent process that spawned us),
// anyone who can reach this port over the network can otherwise call
// list_chats/get_messages/search_messages and read the owner's entire
// WhatsApp message history. It must run before any request is handed to
// the MCP transport below.
function isAuthorized(req: http.IncomingMessage, token: string): boolean {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const provided = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(token);
  return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
}

async function handleHttpRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  token: string
): Promise<void> {
  if (!isAuthorized(req, token)) {
    sendJsonRpcError(res, 401, -32001, "Unauthorized: missing or invalid bearer token");
    return;
  }

  try {
    const transport = new StreamableHTTPServerTransport({
      // Stateless: no Mcp-Session-Id bookkeeping. Each HTTP request is one
      // self-contained JSON-RPC call/response, which is all these five
      // read-only tools ever need.
      sessionIdGenerator: undefined,
    });
    const server = createServer();
    await server.connect(transport);
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await transport.handleRequest(req, res);
  } catch (err) {
    console.error("Error handling whatsapp-mcp HTTP request:", err);
    if (!res.headersSent) {
      sendJsonRpcError(res, 500, -32603, "Internal server error");
    }
  }
}

async function runHttp(): Promise<void> {
  // Fail fast: refuse to listen on a network port at all if there is no
  // token to protect it, rather than silently exposing read access to the
  // owner's WhatsApp message history. See isAuthorized() above and
  // MCP_HTTP_TOKEN in ../common/paths.ts.
  if (!MCP_HTTP_TOKEN) {
    throw new Error(
      "WHATSAPP_MCP_HTTP_TOKEN is required when WHATSAPP_MCP_TRANSPORT=http. Refusing to " +
        "start an unauthenticated network listener that can read WhatsApp message history."
    );
  }
  const token = MCP_HTTP_TOKEN;

  const httpServer = http.createServer((req, res) => {
    void handleHttpRequest(req, res, token);
  });

  await new Promise<void>((resolve) => {
    // Bind on all interfaces: this process is meant to run in its own
    // container, reached from a separate agent container. That's fine —
    // the bearer token is the auth boundary, and actual network exposure
    // is controlled by the docker run/compose port mapping, not by this
    // bind address (unlike the daemon's internal-only IPC port).
    httpServer.listen(MCP_HTTP_PORT, "0.0.0.0", resolve);
  });
  console.error(`whatsapp-mcp MCP server (http transport) listening on 0.0.0.0:${MCP_HTTP_PORT}`);
}

async function main(): Promise<void> {
  if (MCP_TRANSPORT === "http") {
    await runHttp();
    return;
  }
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("whatsapp-mcp MCP server failed to start:", err);
  process.exit(1);
});
