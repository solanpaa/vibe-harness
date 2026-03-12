// ---------------------------------------------------------------------------
// ACP Client Service
// Uses the official @agentclientprotocol/sdk to communicate with Copilot CLI.
// Manages sessions, prompts, and mid-execution interventions.
//
// Protocol ref: https://docs.github.com/en/copilot/reference/acp-server
// ---------------------------------------------------------------------------

import * as acp from "@agentclientprotocol/sdk";
import { spawn, ChildProcess, execSync } from "child_process";
import { Readable, Writable } from "stream";
import { EventEmitter } from "events";
import path from "path";

// ---- Types ----------------------------------------------------------------

export interface AcpMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
  metadata?: {
    toolCalls?: { name: string; input: Record<string, unknown> }[];
    reasoning?: string;
    isIntervention?: boolean;
  };
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
  connection: acp.ClientSideConnection;
  sessionId: string | null;
  status: AcpSessionStatus;
  events: EventEmitter; // emits: update, message, status, close, error
  messages: AcpMessage[];
  workDir: string;
  output: string[]; // raw lines for debugging
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

// ---- Credential helper ----------------------------------------------------

import { buildSandboxCredentials } from "./credential-vault";

// ---- Launch ---------------------------------------------------------------

/**
 * Launch an ACP session with Copilot CLI.
 *
 * For docker sandbox:
 *   docker sandbox run [--name NAME] [-t IMAGE] copilot <dir> -- --yolo --acp --stdio [--model M] [--continue]
 *
 * For direct (no docker):
 *   copilot --acp --stdio
 */
export function launchAcpSession(
  taskId: string,
  options: AcpLaunchOptions
): AcpSession {
  const events = new EventEmitter();
  const output: string[] = [];
  const messages: AcpMessage[] = [];
  const env = { ...process.env };

  // Get GitHub token
  if (!env.GITHUB_TOKEN && !env.GH_TOKEN) {
    try {
      const token = execSync("gh auth token", { encoding: "utf-8" }).trim();
      if (token) env.GITHUB_TOKEN = token;
    } catch {
      // gh CLI not available
    }
  }

  // Inject credentials
  if (options.credentialSetId) {
    const creds = buildSandboxCredentials(options.credentialSetId);
    for (const [key, value] of Object.entries(creds.envVars)) {
      env[key] = value;
    }
  }

  // Build docker sandbox command
  const args: string[] = ["sandbox", "run"];

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

  const agentArgs: string[] = ["--yolo", "--acp", "--stdio"];
  if (options.model) {
    agentArgs.push("--model", options.model);
  }
  if (options.isContinuation) {
    agentArgs.push("--continue");
  }
  args.push("--", ...agentArgs);

  const proc = spawn("docker", args, {
    env,
    cwd: options.projectDir,
    stdio: ["pipe", "pipe", "pipe"],
  });

  // Capture stderr for debugging
  proc.stderr?.on("data", (data: Buffer) => {
    const text = data.toString();
    output.push(text);
  });

  // Create ACP connection using official SDK
  const sdkOutput = Writable.toWeb(proc.stdin!) as WritableStream<Uint8Array>;
  const sdkInput = Readable.toWeb(proc.stdout!) as ReadableStream<Uint8Array>;
  const stream = acp.ndJsonStream(sdkOutput, sdkInput);

  // ACP client callbacks — this is how the agent communicates back
  const client: acp.Client = {
    async requestPermission(params) {
      events.emit("update", { kind: "permission_request", data: params });
      // With --yolo active, permissions are auto-approved server-side.
      // If we somehow receive one, select the first option (most permissive).
      const options = (params as Record<string, unknown>).options as Array<{ id: string }> | undefined;
      if (options && options.length > 0) {
        return { outcome: { outcome: "selected" as const, optionId: options[0].id } };
      }
      return { outcome: { outcome: "cancelled" as const } };
    },

    async sessionUpdate(params) {
      const update = params.update as Record<string, unknown>;
      const updateType = (update.sessionUpdate as string) ?? "";

      if (updateType === "agent_message_chunk") {
        const content = update.content as Record<string, unknown>;
        if (content?.type === "text") {
          const text = content.text as string;
          process.stdout.write(""); // ensure no buffering
          const msg: AcpMessage = {
            id: crypto.randomUUID(),
            role: "assistant",
            content: text,
            timestamp: new Date().toISOString(),
          };
          messages.push(msg);
          events.emit("message", msg);
          events.emit("update", { kind: "assistant_message_delta", data: { text } });
        } else if (content?.type === "tool_use") {
          events.emit("update", {
            kind: "tool_start",
            data: { name: content.name, input: content.input },
          });
        } else if (content?.type === "tool_result") {
          events.emit("update", {
            kind: "tool_complete",
            data: content,
          });
        }
      } else if (updateType === "agent_thought_chunk") {
        const content = update.content as Record<string, unknown>;
        if (content?.type === "text") {
          events.emit("update", {
            kind: "reasoning",
            data: { text: content.text },
          });
        }
      } else if (updateType === "agent_turn_start") {
        session.status = "busy";
        events.emit("status", "busy");
      } else if (updateType === "agent_turn_end") {
        session.status = "ready";
        events.emit("status", "ready");
      } else if (updateType === "tool_result") {
        events.emit("update", { kind: "tool_complete", data: update });
      } else {
        events.emit("update", { kind: updateType || "unknown", data: update });
      }
    },
  };

  const connection = new acp.ClientSideConnection((_agent) => client, stream);

  const session: AcpSession = {
    id: taskId,
    process: proc,
    connection,
    sessionId: null,
    status: "initializing",
    events,
    messages,
    workDir: options.projectDir,
    output,
  };

  proc.on("close", (code) => {
    session.status = "closed";
    events.emit("status", "closed");
    events.emit("close", code ?? 0);
    acpSessions.delete(taskId);
  });

  proc.on("error", (err) => {
    session.status = "error";
    events.emit("error", err);
    acpSessions.delete(taskId);
  });

  acpSessions.set(taskId, session);

  // Initialize connection asynchronously
  initializeSession(session, options).catch((err) => {
    console.error("ACP init failed:", err);
    session.status = "error";
    events.emit("error", err);
  });

  return session;
}

async function initializeSession(session: AcpSession, options: AcpLaunchOptions) {
  // Wait briefly for the docker sandbox to boot
  await new Promise((r) => setTimeout(r, 2000));

  await session.connection.initialize({
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: {},
  });

  const absCwd = path.resolve(options.projectDir);
  const sessionResult = await session.connection.newSession({
    cwd: absCwd,
    mcpServers: [],
  });

  session.sessionId = sessionResult.sessionId;
  session.status = "ready";
  session.events.emit("status", "ready");
  session.events.emit("ready");
}

// ---- Public API -----------------------------------------------------------

/**
 * Send a user message to a running ACP session.
 * This is the core intervention mechanism.
 */
export async function sendAcpPrompt(
  taskId: string,
  message: string,
): Promise<{ success: boolean; stopReason?: string }> {
  const session = acpSessions.get(taskId);
  if (!session || !session.sessionId || session.status === "closed") {
    return { success: false };
  }

  // Record user message
  const userMsg: AcpMessage = {
    id: crypto.randomUUID(),
    role: "user",
    content: message,
    timestamp: new Date().toISOString(),
    metadata: { isIntervention: session.messages.length > 0 },
  };
  session.messages.push(userMsg);
  session.events.emit("message", userMsg);

  session.status = "busy";
  session.events.emit("status", "busy");

  try {
    const result = await session.connection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: message }],
    });

    session.status = "ready";
    session.events.emit("status", "ready");
    return { success: true, stopReason: result.stopReason };
  } catch (err) {
    console.error("ACP prompt failed:", err);
    return { success: false };
  }
}

/**
 * Cancel the current operation.
 */
export function cancelAcpOperation(taskId: string): boolean {
  const session = acpSessions.get(taskId);
  if (!session) return false;
  // Kill the process — ACP SDK doesn't have a cancel method yet
  try {
    session.process.kill("SIGTERM");
  } catch {
    // already dead
  }
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
    session.process.stdin?.end();
    session.process.kill("SIGTERM");
  } catch {
    // already dead
  }
  session.status = "closed";
  acpSessions.delete(taskId);
  return true;
}

/**
 * Check if a task has an active ACP session.
 */
export function isAcpSession(taskId: string): boolean {
  return acpSessions.has(taskId);
}

/**
 * List all active ACP sessions.
 */
export function listAcpSessions(): string[] {
  return Array.from(acpSessions.keys());
}
