// ---------------------------------------------------------------------------
// Session Manager Service (CDD-workflow §4)
//
// Orchestrates sandbox + worktree + ACP for a workflow run. This is the
// bridge between the workflow engine and the lower-level services.
// All stdin writes are serialized through a per-run Mutex (SAD §5.4).
// ---------------------------------------------------------------------------

import type { Logger } from 'pino';
import { Mutex } from '../lib/mutex.js';
import { getDb } from '../db/index.js';
import * as schema from '../db/schema.js';
import { eq } from 'drizzle-orm';
import type { SandboxService, SandboxCredentials } from './sandbox.js';
import type { WorktreeService } from './worktree.js';
import type { AcpClient, AcpEvent } from './acp-client.js';
import type { BranchNamer } from './branch-namer.js';

// ── Public types ─────────────────────────────────────────────────────

export interface AgentDefinition {
  /** Command template for the ACP process (e.g., 'copilot') */
  commandTemplate: string;
  /** Docker image to use for the sandbox */
  dockerImage?: string;
}

export interface FreshSessionContext {
  /** Collected summary/context from prior completed stages */
  summary: string;
}

export interface StageResult {
  status: 'completed' | 'failed';
  lastAssistantMessage: string | null;
  planMarkdown: string | null;
  error?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    model?: string;
    duration?: number;
  };
}

export interface SessionCreateOptions {
  model?: string;
  projectPath: string;
  branchName: string;
  baseBranch?: string;
  credentials?: SandboxCredentials;
  agentDef: AgentDefinition;
}

// ── Internal session state ───────────────────────────────────────────

interface ActiveSession {
  runId: string;
  sandboxName: string;
  worktreePath: string;
  projectPath: string;
  agentDef: AgentDefinition;
  mutex: Mutex;
  lastAssistantMessage: string | null;
  messageBuffer: string;
  lastResult: StageResult | null;
  pendingCompletion: ((result: StageResult) => void) | null;
  /** Model currently active in the ACP session */
  currentModel: string | undefined;
  /** Monotonic counter — incremented each stage start to discard stale results */
  generation: number;
}

// ── Interface ────────────────────────────────────────────────────────

export interface SessionManager {
  create(runId: string, options: SessionCreateOptions): Promise<void>;
  continue(runId: string, options?: { model?: string }): Promise<void>;
  fresh(
    runId: string,
    context: FreshSessionContext,
    options?: { model?: string },
  ): Promise<void>;
  stop(runId: string): Promise<void>;
  sendPrompt(runId: string, message: string): Promise<void>;
  sendIntervention(runId: string, message: string): Promise<void>;
  awaitCompletion(runId: string): Promise<StageResult>;
  isActive(runId: string): boolean;
}

// ── Dependencies ─────────────────────────────────────────────────────

export interface SessionManagerDeps {
  sandbox: SandboxService;
  worktree: WorktreeService;
  acp: AcpClient;
  branchNamer: BranchNamer;
  logger: Logger;
}

// ── Factory ──────────────────────────────────────────────────────────

export function createSessionManager(deps: SessionManagerDeps): SessionManager {
  const { sandbox, worktree, acp, logger } = deps;
  // branchNamer is available via deps for callers that generate branch
  // names before invoking create(); not used directly in current methods.

  /** runId → ActiveSession. In-memory only, lost on daemon restart. */
  const sessions = new Map<string, ActiveSession>();

  // ── Helpers ──────────────────────────────────────────────────────

  function getSession(runId: string): ActiveSession {
    const session = sessions.get(runId);
    if (!session) {
      throw new Error(`No active session for run ${runId}`);
    }
    return session;
  }

  /**
   * Build the ACP event handler that tracks agent messages and resolves
   * the completion promise when a result event arrives.
   */
  function makeEventHandler(session: ActiveSession): (event: AcpEvent) => void {
    // Capture the generation at handler creation so we can discard stale
    // results that arrive after a new stage has already started (fix #3).
    const capturedGeneration = session.generation;

    return (event: AcpEvent) => {
      // Stale event from a prior stage — ignore
      if (session.generation !== capturedGeneration) return;

      if (event.type === 'agent_message') {
        const data = event.data as { content?: string; partial?: boolean };
        if (data.content !== undefined) {
          if (data.partial) {
            session.messageBuffer += data.content;
          } else {
            session.lastAssistantMessage =
              data.content || session.messageBuffer || null;
            session.messageBuffer = '';
          }
        }
      }

      if (event.type === 'result') {
        const data = event.data as {
          exitCode?: number;
          usage?: StageResult['usage'];
        };

        const exitCode = data.exitCode ?? 1;
        const lastMsg =
          session.lastAssistantMessage ??
          (session.messageBuffer || null);

        const result: StageResult = {
          status: exitCode === 0 ? 'completed' : 'failed',
          lastAssistantMessage: lastMsg,
          planMarkdown: null,
          error:
            exitCode !== 0
              ? `Agent exited with code ${exitCode}`
              : undefined,
          usage: data.usage,
        };

        session.lastResult = result;

        if (session.pendingCompletion) {
          session.pendingCompletion(result);
          session.pendingCompletion = null;
        }
      }
    };
  }

  /**
   * Reset completion and message tracking for a new stage/session.
   * If a completion promise is pending, resolve it with a reset indicator
   * to avoid leaving callers hanging.
   */
  function resetCompletionState(session: ActiveSession): void {
    session.generation++;
    if (session.pendingCompletion) {
      session.pendingCompletion({
        status: 'failed',
        lastAssistantMessage: session.lastAssistantMessage,
        planMarkdown: null,
        error: 'Session was reset',
      });
      session.pendingCompletion = null;
    }
    session.lastResult = null;
    session.lastAssistantMessage = null;
    session.messageBuffer = '';
  }

  /** Poll ACP active state until inactive or timeout. */
  function waitForExit(
    sandboxName: string,
    timeoutMs: number,
  ): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      if (!acp.isActive(sandboxName)) {
        resolve(true);
        return;
      }

      const interval = setInterval(() => {
        if (!acp.isActive(sandboxName)) {
          clearInterval(interval);
          clearTimeout(timer);
          resolve(true);
        }
      }, 500);

      const timer = setTimeout(() => {
        clearInterval(interval);
        resolve(false);
      }, timeoutMs);
    });
  }

  // -------------------------------------------------------------------
  // create — Provision sandbox + worktree + ACP session.
  // Called for the first stage of a workflow run (SAD §5.4, Stage 1).
  // -------------------------------------------------------------------

  async function create(
    runId: string,
    options: SessionCreateOptions,
  ): Promise<void> {
    const log = logger.child({ runId, op: 'session.create' });

    if (sessions.has(runId)) {
      log.info('Session already exists, skipping creation (idempotent)');
      return;
    }

    const {
      projectPath,
      branchName,
      baseBranch = 'main',
      credentials,
      agentDef,
      model,
    } = options;

    // 1. Create git worktree
    log.info({ branchName, baseBranch }, 'Creating worktree');
    const { worktreePath } = await worktree.create(
      projectPath,
      branchName,
      baseBranch,
    );

    // 2. Provision Docker sandbox (idempotent via getOrCreate)
    const sandboxName = sandbox.getSandboxName(runId);
    log.info({ sandboxName }, 'Provisioning sandbox');
    await sandbox.getOrCreate({
      runId,
      image: agentDef.dockerImage ?? 'vibe-harness/copilot:latest',
      workdir: worktreePath,
      networkPolicy: 'open',
      credentials,
    });

    // 3. Build session state (added to map only after ACP connects)
    const session: ActiveSession = {
      runId,
      sandboxName,
      worktreePath,
      projectPath,
      agentDef,
      mutex: new Mutex(),
      lastAssistantMessage: null,
      messageBuffer: '',
      lastResult: null,
      pendingCompletion: null,
      currentModel: model,
      generation: 0,
    };

    // 4. Connect ACP (new session, not continuation)
    const env = sandbox.getEnvVars(sandboxName);
    const onEvent = makeEventHandler(session);
    log.info({ model }, 'Connecting ACP session');
    await acp.connect(
      { sandboxName, isContinuation: false, env, model },
      onEvent,
    );

    // 5. Register session only after all provisioning succeeds
    sessions.set(runId, session);

    // 6. Persist session state to DB so create-review.ts and finalize.ts can read it
    const db = getDb();
    db.update(schema.workflowRuns)
      .set({
        sandboxId: sandboxName,
        worktreePath,
        branch: branchName,
      })
      .where(eq(schema.workflowRuns.id, runId))
      .run();

    log.info({ sandboxName, worktreePath, branchName }, 'Session created');
  }

  // -------------------------------------------------------------------
  // continue — Reuse existing sandbox/worktree/ACP connection.
  // Optionally passes new --model. If ACP dropped, reconnects with
  // --continue flag to preserve agent context (SAD §5.4, Stage 2).
  // -------------------------------------------------------------------

  async function sessionContinue(
    runId: string,
    options?: { model?: string },
  ): Promise<void> {
    const session = getSession(runId);
    const log = logger.child({ runId, op: 'session.continue' });

    await session.mutex.runExclusive(async () => {
      // Reset completion tracking for the new stage
      resetCompletionState(session);

      const newModel = options?.model;
      const modelChanged = newModel != null && newModel !== session.currentModel;

      if (acp.isActive(session.sandboxName) && !modelChanged) {
        log.debug('ACP connection active, same model — ready for continuation');
        return;
      }

      // Reconnect — either because ACP dropped or model changed
      if (acp.isActive(session.sandboxName)) {
        log.info({ newModel }, 'Model changed, disconnecting ACP before reconnect');
        acp.disconnect(session.sandboxName);
      }

      log.info({ model: newModel ?? session.currentModel }, 'Reconnecting ACP with --continue');
      const env = sandbox.getEnvVars(session.sandboxName);
      const onEvent = makeEventHandler(session);
      await acp.connect(
        {
          sandboxName: session.sandboxName,
          isContinuation: true,
          env,
          model: newModel ?? session.currentModel,
        },
        onEvent,
      );

      if (newModel) session.currentModel = newModel;
      log.info('ACP reconnected with --continue');
    });
  }

  // -------------------------------------------------------------------
  // fresh — Same sandbox + worktree, but reset ACP session.
  // Disconnects and reconnects without --continue, giving the agent
  // a blank conversation. Context from prior stages is injected by
  // the caller via sendPrompt() after fresh() completes (SAD §5.4).
  // -------------------------------------------------------------------

  async function fresh(
    runId: string,
    context: FreshSessionContext,
    options?: { model?: string },
  ): Promise<void> {
    const session = getSession(runId);
    const log = logger.child({ runId, op: 'session.fresh' });

    await session.mutex.runExclusive(async () => {
      // Disconnect current ACP session
      log.info('Resetting ACP session (fresh)');
      acp.disconnect(session.sandboxName);

      // Reset completion + message tracking
      resetCompletionState(session);

      // Reconnect with a brand-new ACP session (NOT --continue)
      const newModel = options?.model ?? session.currentModel;
      const env = sandbox.getEnvVars(session.sandboxName);
      const onEvent = makeEventHandler(session);
      await acp.connect(
        {
          sandboxName: session.sandboxName,
          isContinuation: false,
          env,
          model: newModel,
        },
        onEvent,
      );

      if (options?.model) session.currentModel = options.model;

      log.info(
        { contextLength: context.summary.length },
        'Fresh ACP session started',
      );
    });
  }

  // -------------------------------------------------------------------
  // stop — Graceful ACP stop + 30 s timeout + force-kill sandbox.
  // SAD §5.4 Cancellation, FR-W10.
  // -------------------------------------------------------------------

  async function stop(runId: string): Promise<void> {
    const session = sessions.get(runId);
    if (!session) return; // Already stopped or never started

    const log = logger.child({ runId, op: 'session.stop' });

    try {
      await session.mutex.runExclusive(async () => {
        // Send graceful ACP stop
        try {
          await acp.sendStop(session.sandboxName);
        } catch {
          log.warn('ACP stop command failed, proceeding to timeout');
        }

        // Wait up to 30 s for agent to exit (FR-W10)
        const stopped = await waitForExit(session.sandboxName, 30_000);

        if (!stopped) {
          log.warn('Agent did not exit within 30s, force-killing sandbox');
          await sandbox.stop(session.sandboxName);
        }

        // Resolve any pending completion inside the mutex to avoid races
        if (session.pendingCompletion) {
          const resolve = session.pendingCompletion;
          session.pendingCompletion = null;
          resolve({
            status: 'failed',
            lastAssistantMessage: session.lastAssistantMessage,
            planMarkdown: null,
            error: 'Session stopped',
          });
        }
      });
    } finally {
      // Clean up ACP connection (best-effort)
      try {
        acp.disconnect(session.sandboxName);
      } catch {
        // Already disconnected
      }

      sessions.delete(runId);
      log.info('Session stopped');
    }
  }

  // -------------------------------------------------------------------
  // sendPrompt — Write a user message to the ACP session stdin.
  // Serialized through the per-run mutex (SAD §5.4).
  // -------------------------------------------------------------------

  async function sendPrompt(runId: string, message: string): Promise<void> {
    const session = getSession(runId);
    await session.mutex.runExclusive(async () => {
      await acp.sendPrompt(session.sandboxName, message);
    });
  }

  // -------------------------------------------------------------------
  // sendIntervention — Inject a user intervention message mid-execution.
  // Same stdin serialization as sendPrompt (FR-W21).
  // -------------------------------------------------------------------

  async function sendIntervention(
    runId: string,
    message: string,
  ): Promise<void> {
    const session = getSession(runId);
    await session.mutex.runExclusive(async () => {
      await acp.sendPrompt(session.sandboxName, message);
    });
  }

  // -------------------------------------------------------------------
  // awaitCompletion — Wait for the agent to signal done.
  // Returns when ACP 'result' event is received or agent exits.
  // Does NOT acquire the mutex — interventions must remain injectable
  // while we are waiting (SAD §5.4).
  // -------------------------------------------------------------------

  async function awaitCompletion(runId: string): Promise<StageResult> {
    const session = getSession(runId);

    // Result already received (fast agent, or called after completion)
    if (session.lastResult) {
      const result = session.lastResult;
      session.lastResult = null;
      return result;
    }

    // Wait for the result event
    return new Promise<StageResult>((resolve) => {
      session.pendingCompletion = resolve;
    });
  }

  // -------------------------------------------------------------------
  // isActive — Check whether a session exists for this run.
  // -------------------------------------------------------------------

  function isActive(runId: string): boolean {
    return sessions.has(runId);
  }

  // ── Public interface ────────────────────────────────────────────

  return {
    create,
    continue: sessionContinue,
    fresh,
    stop,
    sendPrompt,
    sendIntervention,
    awaitCompletion,
    isActive,
  };
}
