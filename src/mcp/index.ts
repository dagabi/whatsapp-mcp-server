/**
 * MCP stdio server — the only surface an MCP client ever talks to.
 *
 * SAFETY INVARIANT: this file registers exactly five tools, all read-only
 * (list_chats, get_messages, search_messages, link_status, sync_now). Each
 * handler does nothing but call `callDaemon(...)`, which can only invoke
 * the closed, read-only method set in ../common/ipcProtocol.ts. There is no
 * sixth tool, and none of these five accepts parameters that could be used
 * to send, edit, delete, or react to a WhatsApp message — those
 * capabilities do not exist anywhere in this codebase. See README.md.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { callDaemon } from "./daemonClient.js";

const server = new McpServer({
  name: "whatsapp-mcp",
  version: "0.1.0",
});

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

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("whatsapp-mcp MCP server failed to start:", err);
  process.exit(1);
});
