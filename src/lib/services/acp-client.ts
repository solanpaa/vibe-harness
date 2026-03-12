// ---------------------------------------------------------------------------
// ACP Client Service
// Manages ACP (Agent Client Protocol) connections to AI agents running in
// Docker sandboxes. Enables structured bidirectional communication including
// mid-session prompt injection and cancellation.
// ---------------------------------------------------------------------------

import { spawn, ChildProcess } from "child_process";
import { EventEmitter } from "events";
import { Readable, Writable } from "stream";

// ---- Types ----------------------------------------------------------------

export interface AcpMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
  metadata?: {
    toolCalls?: AcpToolCall[];
    reasoning?: string;
    isIntervention?: boolean;
  };
}

export interface AcpToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  result?: unknown;
  status?: "running" | "completed" | "failed";
}

export interface AcpSessionUpdate {
  kind:
    | "assistant_message"
    | "assistant_message_delta"
    | "assistant_reasoning"
    | "tool_start"
    | "tool_complete"
    | "status_change"
    | "error";
  data: Record<string, unknown>;
}

export type AcpSessionStatus =
  | "initializing"
  | "ready"
  | "busy"
  | "closed"
  | "error";

export interface AcpSession {
  id: string; // taskId
  process: ChildProcess;
  acpSessionId: string | null;
  status: AcpSessionStatus;
  events: EventEmitter; // emits: 'update', 'status', 'message', 'close', 'error'
  messages: AcpMessage[];
  workDir: string;
  output: string[]; // raw NDJSON lines for debugging
}

export interface AcpLaunchOptions {
  projectDir: string;
  agentCommand: string;
  credentialSetId?: string | null;
  dockerImage?: string | null;
  model?: string | null;
  sandboxName?: string;
  isContinuation?: boolean;
}

// ---- Global session store (survives Next.js hot reloads) ------------------

const globalForAcp = globalThis as unknown as {
  __vibeAcpSessions?: Map<string, AcpSession>;
};
const acpSessions =
  globalForAcp.__vibeAcpSessions ??
  (globalForAcp.__vibeAcpSessions = new Map<string, AcpSession>());

// ---- NDJSON helpers -------------------------------------------------------

function sendJsonRpc(
  proc: ChildProcess,
  method: string,
  params: Record<string, unknown>,
  id?: number
): void {
  const message: Record<string, unknown> = {
    jsonrpc: "2.0",
    method,
    params,
  };
  if (id !== undefined) {
    message.id = id;
  }
  const line = JSON.stringify(message) + "\n";
  proc.stdin?.write(line);
}

function sendJsonRpcNotification(
  proc: ChildProcess,
  method: string,
  params: Record<string, unknown>
): void {
  // Notifications have no id field
  const message = {
    jsonrpc: "2.0",
    method,
    params,
  };
  const line = JSON.stringify(message) + "\n";
  proc.stdin?.write(line);
}

// ---- Request tracking -----------------------------------------------------

let nextRequestId = 1;
type PendingRequest = {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
};

const pendingRequests = new Map<number, PendingRequest>();

// ---- ACP Session Launch ---------------------------------------------------

import { buildSandboxCredentials } from "./credential-vault";

function buildAcpCommand(options: AcpLaunchOptions): {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
} {
  const args: string[] = ["sandbox", "run"];
  const env = { ...process.env };

  if (options.isContinuation && options.sandboxName) {
    args.push(options.sandboxName);
  } else {
    if (options.sandboxName) {
      args.push("--name", options.sandboxName);
    }
    if (options.dockerImage) {
      args.push("-t", options.dockerImage);
    }
    args.push(options.agentCommand);
    args.push(options.projectDir);
  }

  // ACP mode agent args
  const agentArgs: string[] = ["--acp", "--stdio"];

  if (options.model) {
    agentArgs.push("--model", options.model);
  }

  if (options.isContinuation) {
    agentArgs.push("--continue");
  }

  args.push("--", ...agentArgs);

  if (options.credentialSetId) {
    const creds = buildSandboxCredentials(options.credentialSetId);
    for (const [key, value] of Object.entries(creds.envVars)) {
      env[key] = value;
    }
  }

  return { command: "docker", args, env };
}

/**
 * Launch an ACP session with an agent in a Docker sandbox.
 * Returns an AcpSession that can receive prompts and stream updates.
 */
export function launchAcpSession(
  taskId: string,
  options: AcpLaunchOptions
): AcpSession {
  const { command, args, env } = buildAcpCommand(options);
  const events = new EventEmitter();
  const output: string[] = [];
  const messages: AcpMessage[] = [];

  // Try to get GITHUB_TOKEN from gh CLI if not already set
  if (!env.GITHUB_TOKEN && !env.GH_TOKEN) {
    try {
      const token = require("child_process")
        .execSync("gh auth token", { encoding: "utf-8" })
        .trim();
      if (token) env.GITHUB_TOKEN = token;
    } catch {
      // gh CLI not available or not authenticated
    }
  }

  const proc = spawn(command, args, {
    env,
    cwd: options.projectDir,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const session: AcpSession = {
    id: taskId,
    process: proc,
    acpSessionId: null,
    status: "initializing",
    events,
    messages,
    workDir: options.projectDir,
    output,
  };

  // Buffer and parse NDJSON from stdout
  let stdoutBuf = "";
  proc.stdout?.on("data", (data: Buffer) => {
    stdoutBuf += data.toString();
    const lines = stdoutBuf.split("\n");
    stdoutBuf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      output.push(line);
      handleAcpMessage(session, line);
    }
  });

  // Stderr goes to output for debugging
  let stderrBuf = "";
  proc.stderr?.on("data", (data: Buffer) => {
    stderrBuf += data.toString();
    const lines = stderrBuf.split("\n");
    stderrBuf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      output.push(line);
      events.emit("update", {
        kind: "error" as const,
        data: { message: line },
      } satisfies AcpSessionUpdate);
    }
  });

  proc.on("close", (code) => {
    if (stdoutBuf) {
      output.push(stdoutBuf);
      handleAcpMessage(session, stdoutBuf);
    }
    session.status = "closed";
    events.emit("status", "closed");
    events.emit("close", code);
    acpSessions.delete(taskId);
  });

  proc.on("error", (err) => {
    session.status = "error";
    events.emit("status", "error");
    events.emit("error", err);
    acpSessions.delete(taskId);
  });

  acpSessions.set(taskId, session);

  // Initialize ACP connection after process starts
  initializeAcpConnection(session);

  return session;
}

// ---- ACP Protocol Handling ------------------------------------------------

function initializeAcpConnection(session: AcpSession): void {
  const id = nextRequestId++;
  pendingRequests.set(id, {
    resolve: (result: unknown) => {
      // After initialize, create a new session
      createAcpSession(session);
    },
    reject: (error: Error) => {
      console.error("ACP initialize failed:", error);
      session.status = "error";
      session.events.emit("status", "error");
      session.events.emit("error", error);
    },
  });

  sendJsonRpc(session.process, "initialize", {
    protocolVersion: 1,
    capabilities: {
      roots: true,
      sampling: false,
    },
    clientInfo: {
      name: "vibe-harness",
      version: "1.0.0",
    },
  }, id);
}

function createAcpSession(session: AcpSession): void {
  const id = nextRequestId++;
  pendingRequests.set(id, {
    resolve: (result: unknown) => {
      const res = result as Record<string, unknown>;
      session.acpSessionId = (res.sessionId as string) ?? null;
      session.status = "ready";
      session.events.emit("status", "ready");
      session.events.emit("ready");
    },
    reject: (error: Error) => {
      console.error("ACP session/new failed:", error);
      session.status = "error";
      session.events.emit("error", error);
    },
  });

  sendJsonRpc(session.process, "session/new", {}, id);
}

function handleAcpMessage(session: AcpSession, line: string): void {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line.trim());
  } catch {
    // Not JSON — ignore
    return;
  }

  if (typeof parsed !== "object" || parsed === null) return;

  // JSON-RPC response (has id, result/error)
  if ("id" in parsed && typeof parsed.id === "number") {
    const pending = pendingRequests.get(parsed.id);
    if (pending) {
      pendingRequests.delete(parsed.id);
      if ("error" in parsed) {
        const err = parsed.error as Record<string, unknown>;
        pending.reject(new Error((err.message as string) || "ACP error"));
      } else {
        pending.resolve(parsed.result);
      }
    }
    return;
  }

  // JSON-RPC notification from agent (no id)
  if ("method" in parsed && typeof parsed.method === "string") {
    handleAcpNotification(session, parsed.method, (parsed.params ?? {}) as Record<string, unknown>);
    return;
  }

  // Also handle Copilot CLI JSONL-style events for backward compatibility
  if ("type" in parsed && typeof parsed.type === "string") {
    handleCopilotJsonlEvent(session, parsed);
  }
}

function handleAcpNotification(
  session: AcpSession,
  method: string,
  params: Record<string, unknown>
): void {
  switch (method) {
    case "session/update": {
      const updateType = params.type as string;
      const content = params.content as string | undefined;

      if (updateType === "assistant_message" || updateType === "text") {
        session.status = "busy";
        const msg: AcpMessage = {
          id: crypto.randomUUID(),
          role: "assistant",
          content: content ?? "",
          timestamp: new Date().toISOString(),
        };
        session.messages.push(msg);
        session.events.emit("message", msg);
        session.events.emit("update", {
          kind: "assistant_message",
          data: { content },
        } satisfies AcpSessionUpdate);
      } else if (updateType === "assistant_message_delta" || updateType === "text_delta") {
        session.events.emit("update", {
          kind: "assistant_message_delta",
          data: { deltaContent: content ?? params.delta },
        } satisfies AcpSessionUpdate);
      } else if (updateType === "thinking" || updateType === "reasoning") {
        session.events.emit("update", {
          kind: "assistant_reasoning",
          data: { content },
        } satisfies AcpSessionUpdate);
      } else if (updateType === "tool_use" || updateType === "tool_start") {
        session.events.emit("update", {
          kind: "tool_start",
          data: params,
        } satisfies AcpSessionUpdate);
      } else if (updateType === "tool_result" || updateType === "tool_complete") {
        session.events.emit("update", {
          kind: "tool_complete",
          data: params,
        } satisfies AcpSessionUpdate);
      } else if (updateType === "status") {
        const newStatus = params.status as string;
        if (newStatus === "idle" || newStatus === "ready") {
          session.status = "ready";
        } else if (newStatus === "working" || newStatus === "busy") {
          session.status = "busy";
        }
        session.events.emit("status", session.status);
        session.events.emit("update", {
          kind: "status_change",
          data: { status: session.status },
        } satisfies AcpSessionUpdate);
      }
      break;
    }

    case "requestPermission": {
      // Auto-approve all permissions (equivalent to --yolo)
      if ("id" in (params as Record<string, unknown>)) {
        // This is actually a request, not a notification
        // But some agents send it as notification-style
      }
      break;
    }

    default:
      // Unknown notification — emit as generic update
      session.events.emit("update", {
        kind: "status_change",
        data: { method, params },
      } satisfies AcpSessionUpdate);
  }
}

/**
 * Handle Copilot CLI JSONL events that come through even in ACP mode.
 * This provides backward compatibility with the existing event rendering.
 */
function handleCopilotJsonlEvent(
  session: AcpSession,
  event: Record<string, unknown>
): void {
  const type = event.type as string;
  const data = (event.data ?? {}) as Record<string, unknown>;

  switch (type) {
    case "assistant.message": {
      const content = data.content as string | undefined;
      const toolRequests = data.toolRequests as unknown[] | undefined;
      if (content && (!toolRequests || toolRequests.length === 0)) {
        const msg: AcpMessage = {
          id: crypto.randomUUID(),
          role: "assistant",
          content,
          timestamp: new Date().toISOString(),
        };
        session.messages.push(msg);
        session.events.emit("message", msg);
      }
      // Forward as JSONL event for the stream adapter
      session.events.emit("jsonl_event", event);
      break;
    }

    case "user.message": {
      const content = data.content as string | undefined;
      if (content) {
        const msg: AcpMessage = {
          id: crypto.randomUUID(),
          role: "user",
          content,
          timestamp: new Date().toISOString(),
        };
        session.messages.push(msg);
        session.events.emit("message", msg);
      }
      session.events.emit("jsonl_event", event);
      break;
    }

    case "result": {
      session.status = "ready";
      session.events.emit("status", "ready");
      session.events.emit("jsonl_event", event);
      break;
    }

    default:
      // Forward all other JSONL events
      session.events.emit("jsonl_event", event);
  }
}

// ---- ACP Request Handling (agent → client) --------------------------------

/**
 * Handle requests FROM the agent (file reads, terminal, permissions).
 * For now, auto-approve permission requests.
 */
function handleAcpRequest(
  session: AcpSession,
  id: number,
  method: string,
  params: Record<string, unknown>
): void {
  switch (method) {
    case "requestPermission":
      // Auto-approve (like --yolo)
      sendJsonRpc(session.process, "requestPermission", { granted: true }, id);
      break;

    default:
      // Unknown request — return error
      session.process.stdin?.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        }) + "\n"
      );
  }
}

// ---- Public API -----------------------------------------------------------

/**
 * Send a user message/prompt to a running ACP session.
 * This is the core intervention mechanism.
 */
export async function sendAcpPrompt(
  taskId: string,
  message: string,
  context?: { file?: string; line?: number }
): Promise<boolean> {
  const session = acpSessions.get(taskId);
  if (!session || session.status === "closed" || session.status === "error") {
    return false;
  }

  // Store the user message
  const userMsg: AcpMessage = {
    id: crypto.randomUUID(),
    role: "user",
    content: message,
    timestamp: new Date().toISOString(),
    metadata: { isIntervention: true },
  };
  session.messages.push(userMsg);
  session.events.emit("message", userMsg);

  // Send via ACP protocol
  const requestId = nextRequestId++;
  const params: Record<string, unknown> = {
    content: message,
  };
  if (session.acpSessionId) {
    params.sessionId = session.acpSessionId;
  }
  if (context) {
    params.context = context;
  }

  return new Promise<boolean>((resolve) => {
    pendingRequests.set(requestId, {
      resolve: () => {
        session.status = "busy";
        session.events.emit("status", "busy");
        resolve(true);
      },
      reject: (error) => {
        console.error("ACP session/prompt failed:", error);
        // Fallback: try writing directly to stdin
        try {
          session.process.stdin?.write(message + "\n");
          resolve(true);
        } catch {
          resolve(false);
        }
      },
    });

    sendJsonRpc(session.process, "session/prompt", params, requestId);

    // Timeout after 5 seconds — assume success if no response
    setTimeout(() => {
      if (pendingRequests.has(requestId)) {
        pendingRequests.delete(requestId);
        session.status = "busy";
        resolve(true);
      }
    }, 5000);
  });
}

/**
 * Cancel the current operation in an ACP session.
 */
export function cancelAcpOperation(taskId: string): boolean {
  const session = acpSessions.get(taskId);
  if (!session || session.status === "closed") return false;

  sendJsonRpcNotification(session.process, "session/cancel", {
    sessionId: session.acpSessionId ?? undefined,
  } as Record<string, unknown>);

  session.events.emit("update", {
    kind: "status_change",
    data: { status: "cancelling" },
  } satisfies AcpSessionUpdate);

  return true;
}

/**
 * Get an active ACP session by task ID.
 */
export function getAcpSession(taskId: string): AcpSession | undefined {
  return acpSessions.get(taskId);
}

/**
 * Close an ACP session gracefully.
 */
export function closeAcpSession(taskId: string): boolean {
  const session = acpSessions.get(taskId);
  if (!session) return false;

  try {
    session.process.kill("SIGTERM");
  } catch {
    // Process already exited
  }
  session.status = "closed";
  acpSessions.delete(taskId);
  return true;
}

/**
 * List all active ACP sessions.
 */
export function listAcpSessions(): string[] {
  return Array.from(acpSessions.keys());
}

/**
 * Check if a task has an ACP session.
 */
export function isAcpSession(taskId: string): boolean {
  return acpSessions.has(taskId);
}
