#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Vibe Harness MCP Bridge — Stdio MCP server that proxies tool calls to
// the Vibe Harness HTTP API using curl (which respects HTTP_PROXY).
//
// Node.js fetch() inside Docker sandboxes doesn't use the sandbox proxy,
// so HTTP MCP transport fails. This bridge runs as a local/stdio MCP server
// and uses child_process curl to call back to the host.
// ---------------------------------------------------------------------------

const { execSync } = require("child_process");
const readline = require("readline");

const API_BASE = process.env.VIBE_HARNESS_URL || "http://host.docker.internal:3000";
const TASK_ID = process.env.VIBE_TASK_ID || "";

// JSON-RPC helpers
let messageId = 0;
function jsonrpc(id, result) {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}
function jsonrpcError(id, code, message) {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

// Call the Vibe Harness API using curl (respects HTTP_PROXY)
function callApi(path, body) {
  try {
    const result = execSync(
      `curl -s -X POST "${API_BASE}${path}" ` +
      `-H "Content-Type: application/json" ` +
      `-H "Accept: application/json, text/event-stream" ` +
      `-H "X-Task-Id: ${TASK_ID}" ` +
      `-d '${JSON.stringify(body).replace(/'/g, "'\\''")}'`,
      { encoding: "utf-8", timeout: 30000 }
    );
    return JSON.parse(result);
  } catch (e) {
    return { error: e.message };
  }
}

// Tool definitions
const TOOLS = [
  {
    name: "propose_task",
    description: "Propose an independent sub-task for parallel execution. Provide a clear title, description of what to implement, and which files are affected.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short title for the sub-task" },
        description: { type: "string", description: "Detailed description of what to implement" },
        affectedFiles: {
          type: "array",
          items: { type: "string" },
          description: "List of file paths this task will modify"
        },
        dependsOn: {
          type: "array",
          items: { type: "string" },
          description: "Titles of other proposals this depends on (empty if independent)"
        }
      },
      required: ["title", "description"]
    }
  },
  {
    name: "get_plan",
    description: "Retrieve the approved implementation plan from the previous stage.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "list_proposals",
    description: "List all proposals created so far in this session.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "delete_proposal",
    description: "Delete a proposal by its ID.",
    inputSchema: {
      type: "object",
      properties: {
        proposalId: { type: "string", description: "ID of the proposal to delete" }
      },
      required: ["proposalId"]
    }
  },
  {
    name: "get_project_tree",
    description: "Browse the project file structure. Returns a list of tracked files, respecting .gitignore. Use this to understand the codebase layout before splitting work.",
    inputSchema: {
      type: "object",
      properties: {
        directory: { type: "string", description: "Subdirectory to list (relative to project root). Omit for full tree." },
        maxDepth: { type: "integer", description: "Maximum directory depth to include. Omit for unlimited." }
      }
    }
  },
  {
    name: "echo_tool",
    description: "Echo a message back (test tool for verifying MCP connectivity).",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "Message to echo" }
      },
      required: ["message"]
    }
  },
  {
    name: "get_time",
    description: "Get the current server time (test tool).",
    inputSchema: { type: "object", properties: {} }
  }
];

// Handle tool calls
function handleToolCall(name, args) {
  switch (name) {
    case "echo_tool":
      return { content: [{ type: "text", text: `Echo: ${args.message}` }] };
    case "get_time":
      return { content: [{ type: "text", text: `Server time: ${new Date().toISOString()}` }] };
    case "propose_task":
    case "get_plan":
    case "list_proposals":
    case "delete_proposal":
    case "get_project_tree": {
      const result = callApi("/api/mcp/tool", { tool: name, arguments: args, taskId: TASK_ID });
      if (result.error) {
        return { content: [{ type: "text", text: `Error: ${result.error}` }], isError: true };
      }
      return result;
    }
    default:
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }
}

// MCP protocol state
let initialized = false;

function handleMessage(msg) {
  if (msg.method === "initialize") {
    return jsonrpc(msg.id, {
      protocolVersion: "2025-03-26",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "vibe-harness-bridge", version: "0.1.0" }
    });
  }

  if (msg.method === "notifications/initialized") {
    initialized = true;
    return null; // No response for notifications
  }

  if (msg.method === "tools/list") {
    return jsonrpc(msg.id, { tools: TOOLS });
  }

  if (msg.method === "tools/call") {
    const { name, arguments: args } = msg.params;
    const result = handleToolCall(name, args || {});
    return jsonrpc(msg.id, result);
  }

  if (msg.method === "ping") {
    return jsonrpc(msg.id, {});
  }

  // Unknown method
  return jsonrpcError(msg.id, -32601, `Method not found: ${msg.method}`);
}

// Stdio transport
const rl = readline.createInterface({ input: process.stdin, terminal: false });
function send(data) {
  if (data) process.stdout.write(data + "\n");
}

rl.on("line", (line) => {
  if (!line.trim()) return;
  try {
    const msg = JSON.parse(line);
    const response = handleMessage(msg);
    send(response);
  } catch (e) {
    send(jsonrpcError(null, -32700, `Parse error: ${e.message}`));
  }
});

rl.on("close", () => process.exit(0));
process.stderr.write("[vibe-mcp-bridge] Started\n");
