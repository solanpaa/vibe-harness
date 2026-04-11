// ---------------------------------------------------------------------------
// Execute Stage Step (CDD-workflow §3.1)
//
// Sends a prompt into the ACP session and awaits agent completion.
// Manages session mode (create / continue / fresh) based on stage config.
// Idempotent: checks for existing stageExecution before acting.
// ---------------------------------------------------------------------------
"use step";

import { getDb } from '../../db/index.js';
import * as schema from '../../db/schema.js';
import { eq, and, desc } from 'drizzle-orm';
import { buildStagePrompt } from '../../services/prompt-builder.js';
import { logger } from '../../lib/logger.js';
import type { ReviewComment } from '../hooks.js';
import type { SessionManager, StageResult } from '../../services/session-manager.js';
import type { ReviewService } from '../../services/review-service.js';

// ── Input/Output types ───────────────────────────────────────────────

export interface ExecuteStageInput {
  runId: string;
  stage: {
    name: string;
    type: 'standard' | 'split';
    promptTemplate: string;
    freshSession: boolean;
    model?: string;
  };
  stageIndex: number;
  round: number;
  isFirstStage: boolean;
  previousResult: { lastAssistantMessage: string | null; planMarkdown: string | null } | null;
  requestChangesComments: ReviewComment[] | null;
  retryError?: string;
}

export interface ExecuteStageOutput {
  status: 'completed' | 'failed';
  lastAssistantMessage: string | null;
  planMarkdown: string | null;
  error?: string;
}

// ── Dependencies (resolved from globalThis at runtime) ───────────────

export interface ExecuteStageDeps {
  sessionManager: SessionManager;
  reviewService: ReviewService;
  acpClient?: any;
  streamingService?: any;
}

function resolveGlobalDeps(): ExecuteStageDeps {
  const deps = (globalThis as any).__vibe_pipeline_deps__;
  if (!deps) throw new Error('Pipeline deps not initialized');
  return deps;
}

// ── Step implementation ──────────────────────────────────────────────

export async function executeStage(
  input: ExecuteStageInput,
): Promise<ExecuteStageOutput> {
  const allDeps = resolveGlobalDeps() as ExecuteStageDeps;
  const { sessionManager, reviewService, acpClient, streamingService } = allDeps;
  const { runId, stage, round } = input;
  const log = logger.child({ runId, stage: stage.name, round });
  const db = getDb();
  const deps = { sessionManager, reviewService };

  const stageStartTime = Date.now();
  log.info(
    {
      stageName: stage.name,
      stageType: stage.type,
      round,
      isFirstStage: input.isFirstStage,
      isContinuation: !input.isFirstStage && !stage.freshSession,
      freshSession: stage.freshSession,
      hasRetryError: !!input.retryError,
      hasRequestChanges: !!input.requestChangesComments,
      requestChangesCount: input.requestChangesComments?.length ?? 0,
      resolvedModel: stage.model,
    },
    'Stage execution starting',
  );

  // ── Step 1: Idempotency check (SAD §5.3, step 1) ───────────────────
  const existing = db
    .select()
    .from(schema.stageExecutions)
    .where(
      and(
        eq(schema.stageExecutions.workflowRunId, runId),
        eq(schema.stageExecutions.stageName, stage.name),
        eq(schema.stageExecutions.round, round),
      ),
    )
    .get();

  if (existing?.status === 'completed') {
    log.info('Stage already completed, returning cached result');
    return {
      status: 'completed',
      lastAssistantMessage: getLastAssistantMessage(db, runId, stage.name, round),
      planMarkdown: null,
    };
  }

  // Fix #8: If status='running', we are resuming after a daemon crash.
  // Try to re-attach and await completion; mark failed if session gone.
  if (existing?.status === 'running') {
    log.info('Stage already running, skipping to awaitCompletion (resume)');
    if (deps.sessionManager.isActive(runId)) {
      try {
        const result = await deps.sessionManager.awaitCompletion(runId);
        db.update(schema.stageExecutions)
          .set({
            status: result.status,
            completedAt: new Date().toISOString(),
            failureReason: result.error ?? null,
            usageStats: result.usage ? JSON.stringify(result.usage) : null,
          })
          .where(eq(schema.stageExecutions.id, existing.id))
          .run();

        return {
          status: result.status,
          lastAssistantMessage: result.lastAssistantMessage,
          planMarkdown: result.planMarkdown,
          error: result.error,
        };
      } catch {
        // Fall through to failed
      }
    }

    db.update(schema.stageExecutions)
      .set({
        status: 'failed',
        completedAt: new Date().toISOString(),
        failureReason: 'daemon_restart',
      })
      .where(eq(schema.stageExecutions.id, existing.id))
      .run();

    return {
      status: 'failed',
      lastAssistantMessage: null,
      planMarkdown: null,
      error: 'daemon_restart: stage was running when daemon stopped',
    };
  }

  if (existing?.status === 'failed') {
    return {
      status: 'failed',
      lastAssistantMessage: null,
      planMarkdown: null,
      error: existing.failureReason ?? 'Previous execution failed',
    };
  }

  // ── Step 2: Create stageExecution record ────────────────────────────
  const execId = existing?.id ?? crypto.randomUUID();

  // Model resolution (FR-W23): stage.model > run.model > agentDef.defaultModel > undefined
  const run = db
    .select({
      model: schema.workflowRuns.model,
      description: schema.workflowRuns.description,
      agentDefinitionId: schema.workflowRuns.agentDefinitionId,
    })
    .from(schema.workflowRuns)
    .where(eq(schema.workflowRuns.id, runId))
    .get();

  const agentDef = run?.agentDefinitionId
    ? db.select().from(schema.agentDefinitions)
        .where(eq(schema.agentDefinitions.id, run.agentDefinitionId))
        .get()
    : null;

  const resolvedModel = stage.model ?? run?.model ?? (agentDef as any)?.defaultModel ?? undefined;

  if (!existing) {
    db.insert(schema.stageExecutions)
      .values({
        id: execId,
        workflowRunId: runId,
        stageName: stage.name,
        round,
        status: 'pending',
        freshSession: stage.freshSession,
        model: resolvedModel ?? null,
      })
      .run();
  }

  // ── Step 3: Determine session mode (SAD §5.4) ──────────────────────
  try {
    if (input.isFirstStage && round === 1) {
      // First stage of the entire workflow run: session already provisioned
      // by the pipeline's loadContext/provisioning phase
    } else if (stage.freshSession && round === 1) {
      const context = buildFreshSessionContext(db, runId, input.previousResult);
      await deps.sessionManager.fresh(runId, { summary: context }, { model: resolvedModel });
    } else {
      await deps.sessionManager.continue(runId, { model: resolvedModel });
    }

    // ── Step 4: Build prompt ────────────────────────────────────────
    const prompt = buildStagePrompt({
      runDescription: run?.description ?? '',
      stage,
      round,
      retryError: input.retryError ?? null,
      requestChangesComments: input.requestChangesComments,
      freshSessionContext: stage.freshSession
        ? buildFreshSessionContext(db, runId, input.previousResult)
        : null,
    });

    // Store the prompt on the stageExecution record
    db.update(schema.stageExecutions)
      .set({ prompt, status: 'running', startedAt: new Date().toISOString() })
      .where(eq(schema.stageExecutions.id, execId))
      .run();

    // ── Step 5: Register ACP stream for live events ────────────────
    if (acpClient && streamingService) {
      const sandboxName = sessionManager.getSandboxName?.(runId);
      if (sandboxName) {
        streamingService.registerAcpStream(runId, sandboxName, acpClient, stage.name, round);
        log.info({ sandboxName }, 'ACP stream registered for live output');
      }
    }

    // ── Step 6: Send prompt into ACP session ────────────────────────
    const promptPreview = prompt.length > 500 ? prompt.slice(0, 500) + '…' : prompt;
    log.info({ promptLength: prompt.length, preview: promptPreview }, 'Sending stage prompt to agent');
    await sessionManager.sendPrompt(runId, prompt);

    // ── Step 7: Record user prompt in runMessages ───────────────────
    db.insert(schema.runMessages)
      .values({
        workflowRunId: runId,
        stageName: stage.name,
        round,
        sessionBoundary: stage.freshSession && round === 1,
        role: 'user',
        content: prompt,
        isIntervention: false,
      })
      .run();

    // ── Step 8: Await agent completion ───────────────────────────────
    const result = await sessionManager.awaitCompletion(runId);

    // ── Step 9: Save assistant response in runMessages ──────────────
    if (result.lastAssistantMessage) {
      db.insert(schema.runMessages)
        .values({
          workflowRunId: runId,
          stageName: stage.name,
          round,
          sessionBoundary: false,
          role: 'assistant',
          content: result.lastAssistantMessage,
          isIntervention: false,
        })
        .run();
      log.info({ responseLength: result.lastAssistantMessage.length }, 'Assistant response saved');
    }

    // ── Step 10: Update stageExecution ──────────────────────────────
    db.update(schema.stageExecutions)
      .set({
        status: result.status,
        completedAt: new Date().toISOString(),
        failureReason: result.error ?? null,
        usageStats: result.usage ? JSON.stringify(result.usage) : null,
      })
      .where(eq(schema.stageExecutions.id, execId))
      .run();

    log.info(
      {
        status: result.status,
        hasLastAssistantMessage: !!result.lastAssistantMessage,
        lastAssistantMessageLength: result.lastAssistantMessage?.length ?? 0,
        error: result.error,
        durationMs: Date.now() - stageStartTime,
        usage: result.usage,
      },
      'Stage finished',
    );

    return {
      status: result.status,
      lastAssistantMessage: result.lastAssistantMessage,
      planMarkdown: result.planMarkdown,
      error: result.error,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    log.error({ err, durationMs: Date.now() - stageStartTime }, 'Stage execution error');

    db.update(schema.stageExecutions)
      .set({
        status: 'failed',
        completedAt: new Date().toISOString(),
        failureReason: message,
      })
      .where(eq(schema.stageExecutions.id, execId))
      .run();

    return {
      status: 'failed',
      lastAssistantMessage: null,
      planMarkdown: null,
      error: message,
    };
  }
}

// --- Helpers ------------------------------------------------------------- //

function getLastAssistantMessage(
  db: ReturnType<typeof getDb>,
  runId: string,
  stageName: string,
  round: number,
): string | null {
  const msg = db
    .select({ content: schema.runMessages.content })
    .from(schema.runMessages)
    .where(
      and(
        eq(schema.runMessages.workflowRunId, runId),
        eq(schema.runMessages.stageName, stageName),
        eq(schema.runMessages.round, round),
        eq(schema.runMessages.role, 'assistant'),
      ),
    )
    .orderBy(desc(schema.runMessages.createdAt))
    .limit(1)
    .get();
  return msg?.content ?? null;
}

function buildFreshSessionContext(
  db: ReturnType<typeof getDb>,
  runId: string,
  previousResult: { lastAssistantMessage: string | null; planMarkdown: string | null } | null,
): string {
  const completedStages = db
    .select()
    .from(schema.stageExecutions)
    .where(
      and(
        eq(schema.stageExecutions.workflowRunId, runId),
        eq(schema.stageExecutions.status, 'completed'),
      ),
    )
    .all();

  const contextParts: string[] = [];

  for (const se of completedStages) {
    const lastMsg = getLastAssistantMessage(db, runId, se.stageName, se.round);
    if (lastMsg) {
      contextParts.push(
        `## Stage "${se.stageName}" (round ${se.round}) — Agent's Final Response\n\n${lastMsg}`,
      );
    }
  }

  if (previousResult?.planMarkdown) {
    contextParts.push(`## plan.md\n\n${previousResult.planMarkdown}`);
  }

  // Fix #7: Query approved reviews from durable DB data
  const lastReview = db
    .select({ aiSummary: schema.reviews.aiSummary })
    .from(schema.reviews)
    .where(
      and(
        eq(schema.reviews.workflowRunId, runId),
        eq(schema.reviews.status, 'approved'),
      ),
    )
    .orderBy(desc(schema.reviews.createdAt))
    .limit(1)
    .get();

  if (lastReview?.aiSummary) {
    contextParts.push(`## Latest Approved Review Summary\n\n${lastReview.aiSummary}`);
  }

  return contextParts.join('\n\n---\n\n');
}
