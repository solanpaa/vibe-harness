// ---------------------------------------------------------------------------
// ACP Client Service
// Uses the official @agentclientprotocol/sdk to communicate with Copilot CLI.
// Manages sessions, prompts, and mid-execution interventions.
//
// Protocol ref: https://docs.github.com/en/copilot/reference/acp-server
// ---------------------------------------------------------------------------

import * as acp from "@agentclientprotocol/sdk";
import { spawn, execFile, ChildProcess, execSync } from "child_process";
import { promisify } from "util";
import { Readable, Writable } from "stream";
import { EventEmitter } from "events";
import path from "path";

const execFileAsync = promisify(execFile);

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
  process: ChildProcess | null;
  connection: acp.ClientSideConnection | null;
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
  extraWorkspaces?: string[];
  agentCommand: string;
  credentialSetId?: string | null;
  dockerImage?: string | null;
  model?: string | null;
  sandboxName?: string;
  isContinuation?: boolean;
  loadSessionId?: string | null; // Resume existing ACP session (for workflow stage continuation)
  mcpServers?: acp.McpServer[];  // MCP servers to pass to the agent session
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
  // Shared mutable ref so the sessionUpdate closure in bootstrapAcpSession
  // and the proc.on("close") handler share the same buffer.
  const msgBuffer = { value: "" };
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

  // Create session shell — process and connection are assigned once the
  // async bootstrap chain (sandbox create → exec spawn) completes.
  const session: AcpSession = {
    id: taskId,
    process: null,
    connection: null,
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

  // Async bootstrap: create sandbox → configure network → spawn exec → initialize ACP.
  // Runs in the background; callers listen for events.
  bootstrapAcpSession(session, options, env, sandboxName, messages, output, msgBuffer)
    .catch((err) => {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("[ACP] Bootstrap failed:", err);
      output.push(`[ACP BOOTSTRAP ERROR] ${errMsg}`);
      session.status = "error";
      events.emit("error", err);

      if (session.process) {
        // Process was spawned — kill it and let proc.on("close") handle
        // map cleanup and the close event (avoid double-emit).
        try { session.process.kill("SIGTERM"); } catch { /* already dead */ }
      } else {
        // Process was never spawned — clean up the map ourselves and
        // emit close so task-manager sees the failure.
        acpSessions.delete(taskId);
        events.emit("close", 1);
      }
    });

  return session;
}

// ---- Async bootstrap (sandbox create → spawn → init) ----------------------

const SANDBOX_CREATE_TIMEOUT_MS = 300_000; // 5 minutes — no longer blocks event loop
const SANDBOX_CREATE_MAX_RETRIES = 2;
const SANDBOX_CREATE_RETRY_DELAY_MS = 5_000;

async function bootstrapAcpSession(
  session: AcpSession,
  options: AcpLaunchOptions,
  env: NodeJS.ProcessEnv,
  sandboxName: string,
  messages: AcpMessage[],
  output: string[],
  msgBuffer: { value: string },
) {
  const events = session.events;
  const cleanEnv = { ...env };
  delete cleanEnv.NODE_OPTIONS;

  // Check if session was cancelled/closed while we were awaiting.
  // Called after every async step to short-circuit early.
  function isAborted(): boolean {
    return session.status === "closed" || session.status === "error";
  }

  // Step 1: Create sandbox (async, with retry)
  if (!options.isContinuation) {
    const createArgs = ["sandbox", "create", "--name", sandboxName];
    if (options.dockerImage) {
      createArgs.push("-t", options.dockerImage);
    }
    createArgs.push(options.agentCommand, options.projectDir);
    if (options.extraWorkspaces) {
      createArgs.push(...options.extraWorkspaces);
    }

    console.log(`[ACP] Creating sandbox: docker ${createArgs.join(" ")}`);
    events.emit("update", { kind: "sandbox_creating", data: { sandboxName } });

    let created = false;
    for (let attempt = 1; attempt <= SANDBOX_CREATE_MAX_RETRIES; attempt++) {
      try {
        const { stdout } = await execFileAsync("docker", createArgs, {
          env: cleanEnv,
          timeout: SANDBOX_CREATE_TIMEOUT_MS,
        });
        console.log(`[ACP] Sandbox created: ${sandboxName}`);
        output.push(stdout);
        created = true;
        break;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("already exists")) {
          console.log(`[ACP] Sandbox already exists: ${sandboxName}`);
          created = true;
          break;
        }
        if (attempt < SANDBOX_CREATE_MAX_RETRIES) {
          console.warn(`[ACP] Sandbox create attempt ${attempt} failed, retrying in ${SANDBOX_CREATE_RETRY_DELAY_MS / 1000}s: ${msg}`);
          await new Promise((r) => setTimeout(r, SANDBOX_CREATE_RETRY_DELAY_MS));
        } else {
          console.error(`[ACP] Sandbox create failed after ${SANDBOX_CREATE_MAX_RETRIES} attempts: ${msg}`);
          events.emit("update", { kind: "sandbox_create_failed", data: { error: msg } });
          // Don't throw — try exec anyway in case sandbox exists
        }
      }
    }

    if (created) {
      events.emit("update", { kind: "sandbox_created", data: { sandboxName } });
    }
  }

  if (isAborted()) return;

  // Step 2: Configure network proxy for host access
  try {
    await execFileAsync(
      "docker",
      ["sandbox", "network", "proxy", sandboxName, "--allow-host", "localhost"],
      { env: cleanEnv, timeout: 10_000 }
    );
  } catch (err) {
    console.warn(`[ACP] Failed to allow localhost:`, err instanceof Error ? err.message : err);
  }

  if (isAborted()) return;

  // Step 3: Build exec args
  const execArgs = ["sandbox", "exec", "-i"];
  execArgs.push("-e", "NODE_OPTIONS=--max-old-space-size=3072");
  if (env.GITHUB_TOKEN) {
    execArgs.push("-e", `GITHUB_TOKEN=${env.GITHUB_TOKEN}`);
  }
  execArgs.push("-e", `VIBE_TASK_ID=${session.id}`);
  execArgs.push("-e", "VIBE_HARNESS_URL=http://host.docker.internal:3000");
  execArgs.push(sandboxName);

  const copilotArgs = [options.agentCommand, "--acp", "--stdio", "--yolo", "--autopilot"];
  if (options.model) {
    copilotArgs.push("--model", options.model);
  }
  if (options.isContinuation) {
    copilotArgs.push("--continue");
  }

  // Write MCP config into sandbox if needed
  if (options.mcpServers?.length) {
    const mcpServers: Record<string, unknown> = {};
    for (const server of options.mcpServers) {
      if ("url" in server) {
        mcpServers[server.name] = {
          type: "http",
          url: server.url,
          tools: ["*"],
          ...(("headers" in server && server.headers?.length)
            ? { headers: Object.fromEntries(server.headers.map((h: { name: string; value: string }) => [h.name, h.value])) }
            : {}),
        };
      } else if ("command" in server) {
        mcpServers[server.name] = {
          type: "local",
          command: server.command,
          args: server.args,
          tools: ["*"],
          env: server.env ? Object.fromEntries(server.env.map((e: { name: string; value: string }) => [e.name, e.value])) : {},
        };
      }
    }
    const mcpConfigJson = JSON.stringify({ mcpServers });
    const mcpConfigPath = "/tmp/vibe-mcp-config.json";
    try {
      // Write config file into the sandbox via stdin pipe.
      // execSync is fine here — this is a fast 10s-timeout write, not the slow sandbox create.
      execSync(
        `docker sandbox exec -i ${sandboxName} tee ${mcpConfigPath}`,
        { input: mcpConfigJson, env: cleanEnv, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 10_000 }
      );
      copilotArgs.push("--additional-mcp-config", `@${mcpConfigPath}`);
      console.log(`[ACP] Wrote MCP config to sandbox:${mcpConfigPath}`);
      console.log(`[ACP] MCP config: ${mcpConfigJson}`);
    } catch (err) {
      console.warn(`[ACP] Failed to write MCP config file, using inline JSON:`, err instanceof Error ? err.message : err);
      copilotArgs.push("--additional-mcp-config", JSON.stringify({ mcpServers }));
    }

    // Allow sandbox network access to MCP server hosts
    for (const server of options.mcpServers) {
      if ("url" in server) {
        try {
          const url = new URL(server.url);
          const hosts = new Set([url.hostname, "localhost", "127.0.0.1"]);
          const allowArgs = Array.from(hosts).flatMap(h => ["--allow-host", h]);
          await execFileAsync(
            "docker",
            ["sandbox", "network", "proxy", sandboxName, ...allowArgs],
            { env: cleanEnv, timeout: 10_000 }
          );
          console.log(`[ACP] Allowed sandbox network access to: ${Array.from(hosts).join(", ")}`);
        } catch (err) {
          console.warn(`[ACP] Failed to allow MCP host:`, err instanceof Error ? err.message : err);
        }
      }
    }
  }
  execArgs.push(...copilotArgs);

  if (isAborted()) return;

  // Step 4: Spawn the exec process
  console.log(`[ACP] Exec: docker ${execArgs.join(" ")}`);
  const spawnEnv = { ...env };
  delete spawnEnv.NODE_OPTIONS;
  const proc = spawn("docker", execArgs, {
    env: spawnEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });
  session.process = proc;

  // Capture stderr for debugging
  proc.stderr?.on("data", (data: Buffer) => {
    const text = data.toString();
    output.push(text);
    events.emit("update", { kind: "stderr", data: { text } });
  });

  // Tee stdout: feed it to the ACP SDK AND capture raw lines for result parsing.
  // The `result` JSONL event (with usage stats) is emitted on stdout after the
  // ACP protocol ends, so the SDK never sees it. We capture all stdout into
  // output[] so the close handler can parse result/usage data.
  proc.stdout!.on("data", (data: Buffer) => {
    output.push(data.toString());
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
      const opts = (params as Record<string, unknown>).options as Array<{ id: string }> | undefined;
      if (opts && opts.length > 0) {
        return { outcome: { outcome: "selected" as const, optionId: opts[0].id } };
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
            msgBuffer.value += text;
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
          const rawInput = (update.rawInput as Record<string, unknown>) || {};
          const name = (rawInput.description as string)
            || (update as Record<string, unknown>).toolName as string || "tool";
          const detail = JSON.stringify(rawInput).slice(0, 150);
          events.emit("update", { kind: "tool_start", data: { name, detail, args: rawInput } });
          break;
        }
        case "tool_call_update": {
          events.emit("update", { kind: "tool_complete", data: update });
          break;
        }
        case "agent_turn_start": {
          session.status = "busy";
          msgBuffer.value = "";
          events.emit("status", "busy");
          break;
        }
        case "agent_turn_end": {
          if (msgBuffer.value.trim()) {
            const msg: AcpMessage = {
              id: crypto.randomUUID(),
              role: "assistant",
              content: msgBuffer.value,
              timestamp: new Date().toISOString(),
            };
            messages.push(msg);
            events.emit("message", msg);
          }
          msgBuffer.value = "";
          session.status = "ready";
          events.emit("status", "ready");
          events.emit("update", { kind: "turn_end", data: {} });
          break;
        }
        default: {
          if (updateType) {
            events.emit("update", { kind: updateType, data: update });
          }
          break;
        }
      }
    },
  };

  const connection = new acp.ClientSideConnection((_agent) => client, stream);
  session.connection = connection;

  proc.on("close", (code) => {
    if (session.autoCompleteTimer) {
      clearTimeout(session.autoCompleteTimer);
      session.autoCompleteTimer = null;
    }
    if (msgBuffer.value.trim()) {
      const msg: AcpMessage = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: msgBuffer.value,
        timestamp: new Date().toISOString(),
      };
      messages.push(msg);
      events.emit("message", msg);
      msgBuffer.value = "";
    }
    session.status = "closed";
    events.emit("status", "closed");
    const effectiveCode = session.completingGracefully ? 0 : (code ?? 1);
    events.emit("close", effectiveCode);
    acpSessions.delete(session.id);
  });

  proc.on("error", (err) => {
    session.status = "error";
    events.emit("error", err);
    acpSessions.delete(session.id);
  });

  // Step 5: Initialize ACP session
  await initializeSession(session, { ...options, loadSessionId: options.loadSessionId });
}

async function initializeSession(
  session: AcpSession,
  options: AcpLaunchOptions & { loadSessionId?: string | null }
) {
  const MAX_INIT_RETRIES = 3;
  const INIT_DELAY_MS = 1500;

  if (!session.connection) {
    throw new Error("Connection not established before initialization");
  }
  const connection = session.connection;

  // Sandbox is already created — exec connects directly to copilot ACP.
  // Retry initialization in case copilot is slow to start (e.g. under load
  // from concurrent sandbox operations).
  for (let attempt = 1; attempt <= MAX_INIT_RETRIES; attempt++) {
    await new Promise((r) => setTimeout(r, INIT_DELAY_MS));

    if (session.status === "closed" || session.status === "error") {
      throw new Error("Session closed before initialization");
    }

    try {
      console.log(`[ACP] Sending initialize... (attempt ${attempt}/${MAX_INIT_RETRIES})`);
      await connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      break; // success
    } catch (err) {
      if (attempt === MAX_INIT_RETRIES) {
        console.error(`[ACP] Initialize failed after ${MAX_INIT_RETRIES} attempts:`, err);
        throw err;
      }
      console.warn(`[ACP] Initialize attempt ${attempt} failed, retrying...`, err instanceof Error ? err.message : err);
    }
  }

  const absCwd = path.resolve(options.projectDir);
  const mcpServers = options.mcpServers ?? [];

  if (mcpServers.length > 0) {
    console.log(`[ACP] Passing ${mcpServers.length} MCP server(s) to session`);
  }

  if (options.loadSessionId) {
    // Resume existing session — agent replays conversation history
    console.log(`[ACP] Loading session: ${options.loadSessionId}`);
    try {
      await connection.loadSession({
        sessionId: options.loadSessionId,
        cwd: absCwd,
        mcpServers,
      });
      session.sessionId = options.loadSessionId;
      console.log(`[ACP] Session loaded: ${session.sessionId}`);
    } catch (err) {
      console.warn("[ACP] session/load failed, falling back to session/new:", err);
      const sessionResult = await connection.newSession({
        cwd: absCwd,
        mcpServers,
      });
      session.sessionId = sessionResult.sessionId;
      console.log(`[ACP] Fallback session created: ${session.sessionId}`);
    }
  } else {
    // Create fresh session
    console.log(`[ACP] Creating new session, cwd: ${absCwd}`);
    try {
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("session/new timed out after 30s")), 30_000)
      );
      const sessionResult = await Promise.race([
        connection.newSession({ cwd: absCwd, mcpServers }),
        timeoutPromise,
      ]);
      session.sessionId = sessionResult.sessionId;
      console.log(`[ACP] Session created: ${session.sessionId}`);
    } catch (err) {
      console.error("[ACP] session/new failed:", err);
      throw err;
    }
  }

  session.status = "ready";
  session.events.emit("status", "ready");
  session.events.emit("ready");
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
  if (!session || !session.sessionId || !session.connection || session.status === "closed") {
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
  // Mark closed so bootstrapAcpSession aborts if still running
  session.status = "closed";
  try {
    session.process?.kill("SIGTERM");
  } catch {
    // already dead
  }
  // If process was never spawned, clean up the map immediately
  if (!session.process) {
    acpSessions.delete(taskId);
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
  // Mark closed so bootstrapAcpSession aborts if still running
  session.status = "closed";
  try {
    session.process?.stdin?.end();
    session.process?.kill("SIGTERM");
  } catch {
    // already dead
  }
  // If process was never spawned (still bootstrapping), clean up immediately.
  // Otherwise let proc.on("close") handle map cleanup + close event.
  if (!session.process) {
    session.events.emit("status", "closed");
    session.events.emit("close", 0);
    acpSessions.delete(taskId);
  }
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
