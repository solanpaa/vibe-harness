// ---------------------------------------------------------------------------
// ACP Client Service (CDD §5)
//
// Manages NDJSON communication with Copilot CLI running inside Docker
// sandboxes. Spawns `docker sandbox exec -i` processes, parses the ACP
// event stream from stdout, and provides methods to send prompts/stop
// commands via stdin.
// ---------------------------------------------------------------------------

import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import type { Logger } from 'pino';
import * as acp from '@agentclientprotocol/sdk';
import {
  AcpConnectionError,
  AcpSessionNotActiveError,
  AcpConnectionNotFoundError,
} from '../lib/errors.js';

// ── Types (CDD §5.1) ─────────────────────────────────────────────────

export type AcpEventType =
  | 'session_update'
  | 'agent_message'
  | 'agent_thought'
  | 'tool_call'
  | 'tool_result'
  | 'result'
  | 'error';

export interface AcpEvent {
  type: AcpEventType;
  /** Raw JSON payload (structure varies by type) */
  data: Record<string, unknown>;
  /** ISO timestamp of when the daemon received this event */
  receivedAt: string;
}

export interface AcpSessionUpdate {
  type: 'session_update';
  data: {
    sessionId: string;
    status: 'started' | 'ready' | 'completed' | 'error';
  };
}

export interface AcpAgentMessage {
  type: 'agent_message';
  data: {
    content: string;
    partial: boolean;
  };
}

export interface AcpToolCall {
  type: 'tool_call';
  data: {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  };
}

export interface AcpToolResult {
  type: 'tool_result';
  data: {
    callId: string;
    output: string;
    exitCode?: number;
  };
}

export interface AcpResult {
  type: 'result';
  data: {
    exitCode: number;
    usage?: {
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      model?: string;
      duration?: number;
    };
  };
}

export interface AcpError {
  type: 'error';
  data: {
    code: string;
    message: string;
  };
}

export type AcpEventCallback = (event: AcpEvent) => void;

export interface AcpConnectOptions {
  /** Sandbox name to exec into */
  sandboxName: string;
  /** Whether this is a continuation (--continue) */
  isContinuation: boolean;
  /** Environment variables for the copilot process */
  env?: Record<string, string>;
  /** Model override — passed as --model flag */
  model?: string | null;
  /** Worktree path inside the sandbox (used as cwd for session/new) */
  worktreePath?: string;
}

export interface AcpConnection {
  /** Unique session ID assigned by the ACP protocol */
  sessionId: string | null;
  /** Whether the ACP session is still active */
  isActive: boolean;
}

// ── Interface (CDD §5.2) ─────────────────────────────────────────────

export interface AcpAttachment {
  name: string;
  type: string;
  dataUrl: string; // data:mime;base64,...
}

export interface AcpClient {
  connect(options: AcpConnectOptions, onEvent: AcpEventCallback): Promise<AcpConnection>;
  sendPrompt(sandboxName: string, message: string, attachments?: AcpAttachment[]): Promise<void>;
  sendStop(sandboxName: string): Promise<void>;
  onEvent(sandboxName: string, callback: AcpEventCallback): () => void;
  getSessionId(sandboxName: string): string | null;
  isActive(sandboxName: string): boolean;
  disconnect(sandboxName: string): void;
}

// ── Internal state ────────────────────────────────────────────────────

interface ActiveConnection {
  process: ChildProcess;
  acpConnection: acp.ClientSideConnection | null;
  sessionId: string | null;
  listeners: Set<AcpEventCallback>;
  isActive: boolean;
  receivedResult: boolean;
}

// ── GitHub token helper ───────────────────────────────────────────────

// Fallback token resolution — used when no explicit GITHUB_TOKEN in envVars.
// The session-manager calls connect() with envVars that may include
// GITHUB_TOKEN from credentials; this covers the case where none is provided.
function resolveGitHubToken(): string | undefined {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  try {
    const token = execSync('gh auth token', { encoding: 'utf-8', timeout: 5_000 }).trim();
    if (token) return token;
  } catch {
    // gh CLI not available — that's fine
  }
  return undefined;
}

// ── Session wait helper ───────────────────────────────────────────────

const SESSION_TIMEOUT_MS = 30_000;

function waitForSession(conn: ActiveConnection, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (conn.sessionId) {
      resolve();
      return;
    }

    const timeout = setTimeout(() => {
      conn.listeners.delete(checkListener);
      reject(new AcpConnectionError('Timeout waiting for ACP session initialization'));
    }, timeoutMs);

    const checkListener: AcpEventCallback = (event) => {
      if (event.type === 'session_update' && conn.sessionId) {
        clearTimeout(timeout);
        conn.listeners.delete(checkListener);
        resolve();
      }
    };

    conn.listeners.add(checkListener);

    // Also fail if process exits before session is established
    conn.process.on('close', (code) => {
      clearTimeout(timeout);
      conn.listeners.delete(checkListener);
      if (!conn.sessionId) {
        reject(
          new AcpConnectionError(
            `ACP process exited with code ${code} before session established`,
          ),
        );
      }
    });
  });
}

// ── Factory (CDD §5.3) ───────────────────────────────────────────────

export function createAcpClient(deps: { logger: Logger }): AcpClient {
  const { logger } = deps;
  const connections = new Map<string, ActiveConnection>();

  // ------------------------------------------------------------------
  // connect
  // ------------------------------------------------------------------
  async function connect(
    options: AcpConnectOptions,
    onEvent: AcpEventCallback,
  ): Promise<AcpConnection> {
    const { sandboxName, isContinuation, env: extraEnv, model } = options;
    const log = logger.child({ sandboxName });

    // Tear down any existing connection for this sandbox to avoid orphaned processes
    if (connections.has(sandboxName)) {
      log.warn('Disconnecting existing connection before re-connect');
      disconnect(sandboxName);
    }

    // Build copilot flags
    const copilotArgs = ['--acp', '--stdio', '--yolo', '--autopilot'];
    if (isContinuation) copilotArgs.push('--continue');
    if (model) copilotArgs.push('--model', model);

    // Build environment variable flags for docker sandbox exec
    const envArgs: string[] = [];

    // GitHub token
    const ghToken = resolveGitHubToken();
    if (ghToken) {
      envArgs.push('-e', `GITHUB_TOKEN=${ghToken}`);
    }

    // Node memory limit
    envArgs.push('-e', 'NODE_OPTIONS=--max-old-space-size=3072');

    // Caller-supplied env vars
    if (extraEnv) {
      for (const [key, value] of Object.entries(extraEnv)) {
        envArgs.push('-e', `${key}=${value}`);
      }
    }

    // Build the full command args for logging (redact token values)
    const fullArgs = [
      'sandbox', 'exec', '-i',
      ...envArgs,
      sandboxName,
      'copilot', ...copilotArgs,
    ];
    const redactedArgs = fullArgs.map(arg =>
      arg.startsWith('GITHUB_TOKEN=') ? 'GITHUB_TOKEN=<redacted>'
      : arg.startsWith('GH_TOKEN=') ? 'GH_TOKEN=<redacted>'
      : arg,
    );
    log.info(
      { isContinuation, model, hasGhToken: !!ghToken, envKeyCount: Object.keys(extraEnv ?? {}).length },
      'Starting ACP session',
    );
    log.debug({ cmd: ['docker', ...redactedArgs] }, 'Spawning docker sandbox exec');

    const child = spawn(
      'docker',
      fullArgs,
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );

    log.info({ pid: child.pid }, 'ACP process spawned');

    const conn: ActiveConnection = {
      process: child,
      acpConnection: null,
      sessionId: null,
      listeners: new Set([onEvent]),
      isActive: true,
      receivedResult: false,
    };

    connections.set(sandboxName, conn);

    // Log stderr at info level so it's visible by default
    child.stderr!.on('data', (chunk: Buffer) => {
      log.info({ acpStderr: chunk.toString().trim() }, 'ACP stderr');
    });

    // Handle process exit
    child.on('close', (code) => {
      log.info({ exitCode: code }, 'ACP process exited');
      conn.isActive = false;

      if (!conn.receivedResult) {
        const exitEvent: AcpEvent = {
          type: 'result',
          data: { type: 'result', exitCode: code ?? 1 },
          receivedAt: new Date().toISOString(),
        };
        for (const listener of conn.listeners) {
          try { listener(exitEvent); } catch { /* ignore */ }
        }
      }
    });

    // Set up ACP SDK connection (mirrors v1 pattern)
    const sdkOutput = Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>;
    const sdkInput = Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(sdkOutput, sdkInput);

    const acpClient: acp.Client = {
      async requestPermission(params) {
        const opts = (params as Record<string, unknown>).options as Array<{ id: string }> | undefined;
        if (opts && opts.length > 0) {
          return { outcome: { outcome: 'selected' as const, optionId: opts[0].id } };
        }
        return { outcome: { outcome: 'cancelled' as const } };
      },

      async sessionUpdate(params) {
        const update = params.update as Record<string, unknown>;
        const updateType = (update.sessionUpdate as string) ?? '';
        const content = update.content as Record<string, unknown> | undefined;

        // Log raw ACP event for debugging tool names and data structure
        if (updateType === 'tool_call' || updateType === 'tool_call_update') {
          log.info(
            { updateType, rawUpdate: JSON.stringify(update).slice(0, 500) },
            'ACP tool event (raw)',
          );
        } else {
          const previewContent = content
            ? JSON.stringify(content).slice(0, 200)
            : undefined;
          log.debug(
            { updateType, previewContent },
            'ACP sessionUpdate received',
          );
        }

        // Map ACP session updates to our event system
        let eventType: AcpEventType = 'session_update';
        const eventData: Record<string, unknown> = { ...update };

        switch (updateType) {
          case 'agent_message_chunk':
            eventType = 'agent_message';
            if (content?.type === 'text') {
              eventData.content = content.text;
              eventData.partial = true;
            }
            break;
          case 'agent_thought_chunk':
            eventType = 'agent_thought';
            if (content?.type === 'text') {
              eventData.content = content.text;
            }
            break;
          case 'tool_call': {
            eventType = 'tool_call';
            // Extract tool name from ACP event data
            // Copilot CLI uses: kind="edit"|"read", title="Editing .../file.md"
            const toolKind = (update.kind as string) ?? '';
            const toolTitle = (update.title as string) ?? '';
            const rawInput = (update.rawInput as Record<string, unknown>) ?? {};
            const toolName = toolTitle || toolKind || (rawInput.description as string) || 'tool';
            eventData.name = toolName;
            eventData.content = toolName;
            eventData.arguments = rawInput;
            eventData.toolCallId = update.toolCallId;
            eventData.status = update.status;
            break;
          }
          case 'tool_call_update': {
            eventType = 'tool_result';
            const rawOutput = (update.rawOutput as Record<string, unknown>) ?? {};
            eventData.output = (rawOutput.content as string) ?? (rawOutput.message as string) ?? '';
            eventData.callId = update.toolCallId ?? '';
            eventData.status = update.status;
            break;
          }
          case 'agent_turn_end':
            conn.receivedResult = true;
            eventType = 'result';
            eventData.status = 'completed';
            break;
        }

        const event: AcpEvent = {
          type: eventType,
          data: eventData,
          receivedAt: new Date().toISOString(),
        };

        for (const listener of conn.listeners) {
          try { listener(event); } catch (err) {
            log.error({ err }, 'Error in ACP event listener');
          }
        }
      },
    };

    const acpConnection = new acp.ClientSideConnection((_agent) => acpClient, stream);
    conn.acpConnection = acpConnection;

    // ACP protocol handshake: initialize → session/new
    const INIT_DELAY_MS = 1500;
    const MAX_INIT_RETRIES = 3;

    for (let attempt = 1; attempt <= MAX_INIT_RETRIES; attempt++) {
      await new Promise(r => setTimeout(r, INIT_DELAY_MS));

      if (!conn.isActive) {
        throw new AcpConnectionError('ACP process exited before initialization');
      }

      try {
        log.info({ attempt }, 'Sending ACP initialize');
        await acpConnection.initialize({
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
        });
        break;
      } catch (err) {
        if (attempt === MAX_INIT_RETRIES) {
          throw new AcpConnectionError(
            `ACP initialize failed after ${MAX_INIT_RETRIES} attempts: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        log.warn({ attempt, err: err instanceof Error ? err.message : err }, 'ACP initialize attempt failed, retrying');
      }
    }

    // Create or load session
    const worktreePath = options.worktreePath;
    try {
      log.info({ cwd: worktreePath, isContinuation }, 'Creating ACP session');
      const sessionResult = await Promise.race([
        acpConnection.newSession({ cwd: worktreePath ?? '/', mcpServers: [] }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('session/new timed out after 30s')), 30_000),
        ),
      ]);
      conn.sessionId = sessionResult.sessionId;
      log.info({ sessionId: conn.sessionId }, 'ACP session created');
    } catch (err) {
      throw new AcpConnectionError(
        `ACP session creation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return {
      sessionId: conn.sessionId,
      isActive: conn.isActive,
    };
  }

  // ------------------------------------------------------------------
  // sendPrompt — send user message via ACP SDK
  // The prompt() call blocks until the agent finishes. We fire it
  // without awaiting so the caller can use awaitCompletion() separately.
  // When prompt() resolves, we emit a synthetic 'result' event.
  // ------------------------------------------------------------------
  async function sendPrompt(sandboxName: string, message: string, attachments?: AcpAttachment[]): Promise<void> {
    const conn = connections.get(sandboxName);
    if (!conn || !conn.isActive) {
      throw new AcpSessionNotActiveError(sandboxName);
    }
    if (!conn.acpConnection || !conn.sessionId) {
      throw new AcpSessionNotActiveError(sandboxName);
    }

    const log = logger.child({ sandboxName });
    const truncated = message.length > 200 ? message.slice(0, 200) + '…' : message;
    log.info({ promptLength: message.length, preview: truncated, attachmentCount: attachments?.length ?? 0 }, 'Sending prompt to ACP');

    // Build content blocks: text first, then images
    const prompt: Array<{ type: string; text?: string; data?: string; mimeType?: string }> = [
      { type: 'text', text: message },
    ];

    if (attachments?.length) {
      for (const att of attachments) {
        if (att.type.startsWith('image/')) {
          // Extract base64 data from data URL (strip "data:image/png;base64," prefix)
          const base64Data = att.dataUrl.replace(/^data:[^;]+;base64,/, '');
          prompt.push({ type: 'image', data: base64Data, mimeType: att.type });
        }
      }
    }

    // Fire prompt() without awaiting — it resolves when agent finishes
    conn.acpConnection.prompt({
      sessionId: conn.sessionId,
      prompt: prompt as any,
    }).then((result) => {
      log.info({ stopReason: result?.stopReason }, 'ACP prompt completed');
      conn.receivedResult = true;

      const event: AcpEvent = {
        type: 'result',
        data: { type: 'result', status: 'completed', stopReason: result?.stopReason },
        receivedAt: new Date().toISOString(),
      };
      for (const listener of conn.listeners) {
        try { listener(event); } catch (err) {
          log.error({ err }, 'Error in ACP event listener (result)');
        }
      }
    }).catch((err) => {
      log.error({ err: err instanceof Error ? err.message : err }, 'ACP prompt failed');
      const event: AcpEvent = {
        type: 'result',
        data: { type: 'result', status: 'failed', error: err instanceof Error ? err.message : String(err) },
        receivedAt: new Date().toISOString(),
      };
      for (const listener of conn.listeners) {
        try { listener(event); } catch { /* ignore */ }
      }
    });
  }

  // ------------------------------------------------------------------
  // sendStop — disconnect the ACP session gracefully
  // ------------------------------------------------------------------
  async function sendStop(sandboxName: string): Promise<void> {
    const conn = connections.get(sandboxName);
    if (!conn || !conn.isActive) return; // Idempotent

    // Kill the process — the ACP SDK doesn't have a "stop" method
    try {
      conn.process.kill('SIGTERM');
    } catch { /* already exited */ }
  }

  // ------------------------------------------------------------------
  // onEvent — register additional event listener
  // ------------------------------------------------------------------
  function onEvent(sandboxName: string, callback: AcpEventCallback): () => void {
    const conn = connections.get(sandboxName);
    if (!conn) {
      throw new AcpConnectionNotFoundError(sandboxName);
    }

    conn.listeners.add(callback);
    return () => { conn.listeners.delete(callback); };
  }

  // ------------------------------------------------------------------
  // getSessionId
  // ------------------------------------------------------------------
  function getSessionId(sandboxName: string): string | null {
    return connections.get(sandboxName)?.sessionId ?? null;
  }

  // ------------------------------------------------------------------
  // isActive
  // ------------------------------------------------------------------
  function isActive(sandboxName: string): boolean {
    return connections.get(sandboxName)?.isActive ?? false;
  }

  // ------------------------------------------------------------------
  // disconnect — clean up connection and kill process
  // ------------------------------------------------------------------
  function disconnect(sandboxName: string): void {
    const conn = connections.get(sandboxName);
    if (conn) {
      const log = logger.child({ sandboxName });
      log.info({ pid: conn.process.pid, hadSession: !!conn.sessionId }, 'Disconnecting ACP');
      conn.isActive = false;
      conn.listeners.clear();
      if (!conn.process.killed) {
        conn.process.kill('SIGTERM');
      }
      connections.delete(sandboxName);
    }
  }

  return { connect, sendPrompt, sendStop, onEvent, getSessionId, isActive, disconnect };
}
