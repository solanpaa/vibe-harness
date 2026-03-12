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

export interface AcpSessionEvent {
  kind: string;
  data: Record<string, unknown>;
  timestamp: string;
}

export interface AcpSession {
  id: string; // taskId
  process: ChildProcess;
  connection: acp.ClientSideConnection;
  sessionId: string | null;
  status: AcpSessionStatus;
  events: EventEmitter; // emits: update, message, status, close, error, auto_complete
  messages: AcpMessage[];
  eventLog: AcpSessionEvent[]; // buffered events for replay on reconnect
  workDir: string;
  output: string[]; // raw lines for debugging
  autoCompleteTimer: ReturnType<typeof setTimeout> | null;
  userIntervened: boolean; // true if user sent a message after initial prompt
  completingGracefully: boolean; // true when we intentionally close the session
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

  const sandboxName = options.sandboxName || `vibe-${taskId.slice(0, 8)}`;

  // Step 1: Create sandbox (synchronous, boots the VM)
  // For continuations, the sandbox already exists — skip create.
  if (!options.isContinuation) {
    try {
      const createArgs = ["sandbox", "create", "--name", sandboxName];
      if (options.dockerImage) {
        createArgs.push("-t", options.dockerImage);
      }
      createArgs.push(options.agentCommand, options.projectDir);
      console.log(`[ACP] Creating sandbox: docker ${createArgs.join(" ")}`);
      const createEnv = { ...env };
      delete createEnv.NODE_OPTIONS;
      const result = execSync(`docker ${createArgs.join(" ")}`, {
        env: createEnv,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 120_000,
      });
      console.log(`[ACP] Sandbox created: ${sandboxName}`);
      output.push(result);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // If sandbox already exists, that's fine
      if (!msg.includes("already exists")) {
        console.error(`[ACP] Sandbox create failed: ${msg}`);
        // Don't throw — try exec anyway in case sandbox exists
      }
    }
  }

  // Step 2: Exec copilot in ACP mode inside the sandbox
  // Using -i (interactive) to keep stdin open for the NDJSON stream
  const execArgs = ["sandbox", "exec", "-i"];

  // Pass GitHub token for authentication
  if (env.GITHUB_TOKEN) {
    execArgs.push("-e", `GITHUB_TOKEN=${env.GITHUB_TOKEN}`);
  }

  execArgs.push(sandboxName);

  // Build the copilot command with ACP flags
  const copilotArgs = [options.agentCommand, "--acp", "--stdio", "--yolo", "--autopilot"];
  if (options.model) {
    copilotArgs.push("--model", options.model);
  }
  if (options.isContinuation) {
    copilotArgs.push("--continue");
  }
  execArgs.push(...copilotArgs);

  console.log(`[ACP] Exec: docker ${execArgs.join(" ")}`);
  // Strip NODE_OPTIONS to prevent Next.js flags (e.g. --no-warnings)
  // from leaking into the copilot process inside the sandbox
  const spawnEnv = { ...env };
  delete spawnEnv.NODE_OPTIONS;
  const proc = spawn("docker", execArgs, {
    env: spawnEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });

  // Capture stderr for debugging
  proc.stderr?.on("data", (data: Buffer) => {
    const text = data.toString();
    output.push(text);
    events.emit("update", { kind: "stderr", data: { text } });
  });

  // With docker sandbox exec -i, stdout is clean NDJSON — no boot
  // messages or shell prompt markers to filter. Connect SDK directly.
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
      const content = update.content as Record<string, unknown> | undefined;

      switch (updateType) {
        case "agent_message_chunk": {
          if (content?.type === "text") {
            const text = content.text as string;
            events.emit("update", { kind: "assistant_message_delta", data: { text } });
          } else if (content?.type === "tool_use") {
            events.emit("update", {
              kind: "tool_start",
              data: { name: content.name, input: content.input },
            });
          } else if (content?.type === "tool_result") {
            events.emit("update", { kind: "tool_complete", data: content });
          }
          break;
        }
        case "agent_thought_chunk": {
          if (content?.type === "text") {
            events.emit("update", { kind: "reasoning", data: { text: content.text } });
          }
          break;
        }
        case "tool_call": {
          // Tool execution started
          const name = (update.rawInput as Record<string, unknown>)?.description as string
            || (update as Record<string, unknown>).toolName as string || "tool";
          const detail = JSON.stringify((update.rawInput as Record<string, unknown>) || {}).slice(0, 150);
          events.emit("update", { kind: "tool_start", data: { name, detail } });
          break;
        }
        case "tool_call_update": {
          // Tool result came back
          events.emit("update", { kind: "tool_complete", data: update });
          break;
        }
        case "agent_turn_start": {
          session.status = "busy";
          events.emit("status", "busy");
          break;
        }
        case "agent_turn_end": {
          // Accumulate the full message from all deltas
          session.status = "ready";
          events.emit("status", "ready");
          // Signal that a complete turn is done
          events.emit("update", { kind: "turn_end", data: {} });
          break;
        }
        default: {
          // Forward unknown events for debugging
          if (updateType) {
            events.emit("update", { kind: updateType, data: update });
          }
          break;
        }
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
    eventLog: [],
    workDir: options.projectDir,
    output,
    autoCompleteTimer: null,
    userIntervened: false,
    completingGracefully: false,
  };

  proc.on("close", (code) => {
    if (session.autoCompleteTimer) {
      clearTimeout(session.autoCompleteTimer);
      session.autoCompleteTimer = null;
    }
    session.status = "closed";
    events.emit("status", "closed");
    // If we intentionally closed the session (auto-complete or manual complete),
    // treat it as success (code 0) regardless of the actual exit code.
    const effectiveCode = session.completingGracefully ? 0 : (code ?? 0);
    events.emit("close", effectiveCode);
    acpSessions.delete(taskId);
  });

  proc.on("error", (err) => {
    session.status = "error";
    events.emit("error", err);
    acpSessions.delete(taskId);
  });

  acpSessions.set(taskId, session);

  // Buffer all events for replay on stream reconnect
  events.on("update", (update: { kind: string; data: Record<string, unknown> }) => {
    session.eventLog.push({ ...update, timestamp: new Date().toISOString() });
  });
  events.on("message", (msg: AcpMessage) => {
    session.eventLog.push({
      kind: "message",
      data: { role: msg.role, content: msg.content, isIntervention: msg.metadata?.isIntervention ?? false },
      timestamp: msg.timestamp,
    });
  });
  events.on("status", (status: string) => {
    session.eventLog.push({
      kind: "status",
      data: { status },
      timestamp: new Date().toISOString(),
    });
  });

  // Initialize connection asynchronously
  initializeSession(session, options).catch((err) => {
    console.error("ACP init failed:", err);
    session.status = "error";
    events.emit("error", err);
  });

  return session;
}

async function initializeSession(session: AcpSession, options: AcpLaunchOptions) {
  // Sandbox is already created — exec connects directly to copilot ACP.
  // Give copilot a moment to start inside the sandbox.
  await new Promise((r) => setTimeout(r, 1000));

  if (session.status === "closed" || session.status === "error") {
    throw new Error("Session closed before initialization");
  }

  console.log("[ACP] Sending initialize...");

  await session.connection.initialize({
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: {},
  });

  console.log("[ACP] Initialized, creating session...");

  const absCwd = path.resolve(options.projectDir);
  console.log(`[ACP] session/new cwd: ${absCwd}`);
  try {
    // Add timeout — session/new can hang if cwd doesn't exist in sandbox
    const sessionPromise = session.connection.newSession({
      cwd: absCwd,
      mcpServers: [],
    });
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("session/new timed out after 30s")), 30_000)
    );
    const sessionResult = await Promise.race([sessionPromise, timeoutPromise]);

    session.sessionId = sessionResult.sessionId;
    console.log(`[ACP] Session created: ${session.sessionId}`);
    session.status = "ready";
    session.events.emit("status", "ready");
    session.events.emit("ready");
  } catch (err) {
    console.error("[ACP] session/new failed:", err);
    throw err;
  }
}

// ---- Public API -----------------------------------------------------------

const AUTO_COMPLETE_DELAY_MS = 5_000;

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

  // Cancel any pending auto-complete timer
  if (session.autoCompleteTimer) {
    clearTimeout(session.autoCompleteTimer);
    session.autoCompleteTimer = null;
    session.events.emit("update", { kind: "auto_complete_cancelled", data: {} });
  }

  // Track whether the user has intervened (any message after the first)
  const isIntervention = session.messages.length > 0;
  if (isIntervention) {
    session.userIntervened = true;
  }

  // Record user message
  const userMsg: AcpMessage = {
    id: crypto.randomUUID(),
    role: "user",
    content: message,
    timestamp: new Date().toISOString(),
    metadata: { isIntervention },
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

    // Start auto-complete timer if user hasn't intervened
    if (!session.userIntervened && result.stopReason === "end_turn") {
      console.log(`[ACP] Turn complete. Auto-completing in ${AUTO_COMPLETE_DELAY_MS / 1000}s...`);
      session.events.emit("update", {
        kind: "auto_complete_pending",
        data: { delayMs: AUTO_COMPLETE_DELAY_MS },
      });
      session.autoCompleteTimer = setTimeout(() => {
        console.log(`[ACP] Auto-complete timer fired, closing session`);
        session.autoCompleteTimer = null;
        closeAcpSession(taskId);
      }, AUTO_COMPLETE_DELAY_MS);
    }

    return { success: true, stopReason: result.stopReason };
  } catch (err) {
    console.error("ACP prompt failed:", err);
    return { success: false };
  }
}

/**
 * Cancel the auto-complete timer for a session (user wants to keep editing).
 */
export function cancelAutoComplete(taskId: string): boolean {
  const session = acpSessions.get(taskId);
  if (!session) return false;
  if (session.autoCompleteTimer) {
    clearTimeout(session.autoCompleteTimer);
    session.autoCompleteTimer = null;
    session.userIntervened = true;
    session.events.emit("update", { kind: "auto_complete_cancelled", data: {} });
    return true;
  }
  return false;
}

/**
 * Manually complete a task — close the ACP session to trigger review.
 */
export function completeAcpSession(taskId: string): boolean {
  const session = acpSessions.get(taskId);
  if (!session) return false;
  if (session.autoCompleteTimer) {
    clearTimeout(session.autoCompleteTimer);
    session.autoCompleteTimer = null;
  }
  session.completingGracefully = true;
  return closeAcpSession(taskId);
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
 * Close an ACP session gracefully — marks as completing so close handler treats as success.
 */
export function closeAcpSession(taskId: string): boolean {
  const session = acpSessions.get(taskId);
  if (!session) return false;
  session.completingGracefully = true;
  try {
    session.process.stdin?.end();
    session.process.kill("SIGTERM");
  } catch {
    // already dead
  }
  // Don't delete from map or set status here — let proc.on("close") handle it
  // so the close event fires properly to task-manager
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
