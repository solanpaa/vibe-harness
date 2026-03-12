// ---------------------------------------------------------------------------
// MCP Test Endpoint — Testbench for MCP ↔ ACP ↔ Docker sandbox flow
//
// Uses @modelcontextprotocol/sdk WebStandardStreamableHTTPServerTransport
// for Next.js App Router compatibility. Stateless mode — each request
// creates a fresh transport (no Redis, no session store needed).
//
// Usage: pass as MCP server when creating an ACP session:
//   { type: "http", name: "vibe-harness-test",
//     url: "http://host.docker.internal:3000/api/mcp-test",
//     headers: [] }
// ---------------------------------------------------------------------------

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

const notes: string[] = [];

function createServer(): McpServer {
  const server = new McpServer(
    { name: "vibe-harness-test", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  server.tool(
    "echo_tool",
    "Echoes the message back. Use this to test MCP connectivity.",
    { message: z.string().describe("The message to echo back") },
    async ({ message }) => ({
      content: [{ type: "text" as const, text: `Echo: ${message}` }],
    })
  );

  server.tool(
    "get_time",
    "Returns the current server time.",
    {},
    async () => ({
      content: [
        { type: "text" as const, text: `Server time: ${new Date().toISOString()}` },
      ],
    })
  );

  server.tool(
    "store_note",
    "Stores a note on the server. Use this to test that MCP tool side-effects work.",
    { note: z.string().describe("The note to store") },
    async ({ note }) => {
      notes.push(note);
      return {
        content: [
          { type: "text" as const, text: `Stored note #${notes.length}: "${note}"` },
        ],
      };
    }
  );

  server.tool(
    "list_notes",
    "Lists all stored notes.",
    {},
    async () => ({
      content: [
        {
          type: "text" as const,
          text:
            notes.length > 0
              ? `Notes:\n${notes.map((n, i) => `${i + 1}. ${n}`).join("\n")}`
              : "No notes stored yet.",
        },
      ],
    })
  );

  return server;
}

// Stateful sessions: keep server + transport alive across protocol lifecycle
const sessions = new Map<
  string,
  { server: McpServer; transport: WebStandardStreamableHTTPServerTransport }
>();

async function handleMcpRequest(request: Request): Promise<Response> {
  // Ensure Accept header includes required types — some MCP clients
  // (e.g. copilot CLI) may not send the full Accept header.
  const accept = request.headers.get("accept") || "";
  if (!accept.includes("text/event-stream") || !accept.includes("application/json")) {
    const headers = new Headers(request.headers);
    headers.set("accept", "application/json, text/event-stream");
    request = new Request(request.url, {
      method: request.method,
      headers,
      body: request.body,
      // @ts-expect-error duplex required for streaming body in Node.js
      duplex: "half",
    });
  }

  const sessionId = request.headers.get("mcp-session-id");

  // Route to existing session if we have one
  if (sessionId && sessions.has(sessionId)) {
    const { transport } = sessions.get(sessionId)!;
    return transport.handleRequest(request);
  }

  // New session: create stateful transport
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    enableJsonResponse: true,
    onsessioninitialized: (id) => {
      console.log(`[MCP Test] Session initialized: ${id}`);
      sessions.set(id, { server, transport });
    },
    onsessionclosed: (id) => {
      console.log(`[MCP Test] Session closed: ${id}`);
      sessions.delete(id);
    },
  });

  const server = createServer();
  await server.connect(transport);

  return transport.handleRequest(request);
}

export async function POST(request: Request) {
  return handleMcpRequest(request);
}

export async function GET(request: Request) {
  return handleMcpRequest(request);
}

export async function DELETE(request: Request) {
  return handleMcpRequest(request);
}


