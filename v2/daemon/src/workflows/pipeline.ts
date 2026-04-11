// ---------------------------------------------------------------------------
// Main Workflow Pipeline (CDD-workflow §1)
//
// The top-level durable workflow function. All stage sequencing, hook
// suspension, parallel fan-out/fan-in, and finalization live here.
// The "use workflow" runtime may re-execute this function from the
// beginning on daemon restart, replaying completed steps from the event
// log and resuming from the last suspension point (SAD §5.1).
// ---------------------------------------------------------------------------
"use workflow";

import { sleep } from 'workflow';
import { getDb } from '../db/index.js';
import * as schema from '../db/schema.js';
import { eq, and, desc } from 'drizzle-orm';
import { logger } from '../lib/logger.js';

import {
  reviewDecisionHook,
  stageFailedHook,
  proposalReviewHook,
  parallelCompletionHook,
  conflictResolutionHook,
  type ReviewComment,
} from './hooks.js';

import { executeStage, type ExecuteStageOutput, type ExecuteStageDeps } from './steps/execute-stage.js';
import { createReview, type CreateReviewDeps } from './steps/create-review.js';
import { finalize, type FinalizeDeps } from './steps/finalize.js';

// ── Types ────────────────────────────────────────────────────────────

export interface PipelineInput {
  runId: string;
  /** Injected service dependencies. Provided by the route handler at start(). */
  deps: PipelineDeps;
}

export interface PipelineDeps extends ExecuteStageDeps, CreateReviewDeps, FinalizeDeps {}

interface PipelineContext {
  runId: string;
  projectId: string;
  agentDefinitionId: string;
  description: string;
  baseBranch: string;
  targetBranch: string;
  credentialSetId: string | null;
  stages: WorkflowStage[];
}

interface WorkflowStage {
  name: string;
  type: 'standard' | 'split';
  promptTemplate: string;
  reviewRequired: boolean;
  autoAdvance: boolean;
  freshSession: boolean;
  model?: string;
}

interface FailureDecisionResult extends ExecuteStageOutput {
  action?: 'skip';
}

interface SplitResult {
  consolidationSummary: string;
  mergedDiffStats: string | null;
}

// ── Pipeline ─────────────────────────────────────────────────────────

export async function runWorkflowPipeline(input: PipelineInput) {
  "use workflow";

  const { deps } = input;
  const ctx = loadContext(input.runId);

  updateRunStatus(ctx.runId, 'provisioning');

  // Provision session for the first stage
  const firstStage = ctx.stages[0];
  if (firstStage) {
    const resolvedModel = firstStage.model ?? getRunModel(ctx.runId) ?? undefined;
    const run = getRunRecord(ctx.runId);
    if (run && !deps.sessionManager.isActive(ctx.runId)) {
      const project = getProject(ctx.projectId);
      if (project) {
        await deps.sessionManager.create(ctx.runId, {
          model: resolvedModel,
          projectPath: project.localPath,
          branchName: run.branch ?? `vibe-harness/run-${ctx.runId.slice(0, 8)}`,
          baseBranch: ctx.baseBranch,
          agentDef: getAgentDef(ctx.agentDefinitionId),
        });

        // Persist worktree path and sandbox info back to DB
        // (session manager creates these as side effects)
      }
    }
  }

  let previousResult: ExecuteStageOutput | null = null;
  let splitResult: SplitResult | null = null;

  for (let i = 0; i < ctx.stages.length; i++) {
    const stage = ctx.stages[i];
    const isFinal = i === ctx.stages.length - 1;

    updateRunStatus(ctx.runId, 'running');
    updateCurrentStage(ctx.runId, stage.name);

    // Fix #6: After a split stage, force freshSession=true
    const effectiveFreshSession = splitResult != null ? true : stage.freshSession;
    const effectiveStage = { ...stage, freshSession: effectiveFreshSession };

    // ── 1. Execute stage ──────────────────────────────────────────────
    let result = await executeStage(
      {
        runId: ctx.runId,
        stage: effectiveStage,
        stageIndex: i,
        round: 1,
        isFirstStage: i === 0,
        previousResult,
        requestChangesComments: null,
      },
      deps,
    );

    // ── 2. Handle stage failure ───────────────────────────────────────
    if (result.status === 'failed') {
      const decision = await handleStageFailure(ctx, stage, result, i, deps);

      if (decision.action === 'skip') {
        previousResult = null;
        splitResult = null;
        continue;
      }
      if (decision.status === 'failed') {
        updateRunStatus(ctx.runId, 'failed');
        await deps.sessionManager.stop(ctx.runId);
        return;
      }
      result = decision;
    }

    // ── 3. Split stage handling ───────────────────────────────────────
    if (stage.type === 'split') {
      // Split stages are not yet fully implemented — placeholder for
      // extract-proposals → proposal-hook → launch-children → consolidate.
      // For now, treat as standard stage and continue.
      splitResult = null;
      previousResult = result;
      continue;
    }

    // ── 4. Review gate (standard stages) ──────────────────────────────
    if (stage.reviewRequired) {
      result = await handleReviewGate(ctx, stage, result, deps);
      if (result.status === 'failed') {
        updateRunStatus(ctx.runId, 'failed');
        await deps.sessionManager.stop(ctx.runId);
        return;
      }
    }

    // ── 5. Finalization (last stage) ──────────────────────────────────
    if (isFinal) {
      await handleFinalization(ctx, deps);
    }

    previousResult = result;
    splitResult = null;
  }

  // ── 6. Terminal state ───────────────────────────────────────────────
  updateRunStatus(ctx.runId, 'completed');
  await deps.sessionManager.stop(ctx.runId);
}

// --- Stage failure sub-flow ---------------------------------------------- //

async function handleStageFailure(
  ctx: PipelineContext,
  stage: WorkflowStage,
  failedResult: ExecuteStageOutput,
  stageIndex: number,
  deps: PipelineDeps,
): Promise<FailureDecisionResult> {
  updateRunStatus(ctx.runId, 'stage_failed');

  const hookToken = `failed:${ctx.runId}:${stage.name}:${Date.now()}`;
  using hook = stageFailedHook.create({ token: hookToken });
  const decision = await hook;

  switch (decision.action) {
    case 'retry': {
      const currentRound = getCurrentRound(ctx.runId, stage.name);
      const retryResult = await executeStage(
        {
          runId: ctx.runId,
          stage,
          stageIndex,
          round: currentRound + 1,
          isFirstStage: false,
          previousResult: null,
          requestChangesComments: null,
          retryError: failedResult.error,
        },
        deps,
      );

      if (retryResult.status === 'failed') {
        return handleStageFailure(ctx, stage, retryResult, stageIndex, deps);
      }
      return retryResult;
    }

    case 'skip':
      markStageSkipped(ctx.runId, stage.name);
      return {
        status: 'completed',
        lastAssistantMessage: null,
        planMarkdown: null,
        action: 'skip',
      };

    case 'cancel':
      return failedResult;
  }
}

// --- Review gate sub-flow ------------------------------------------------ //

async function handleReviewGate(
  ctx: PipelineContext,
  stage: WorkflowStage,
  result: ExecuteStageOutput,
  deps: PipelineDeps,
): Promise<ExecuteStageOutput> {
  let currentResult = result;
  let round = 1;

  while (true) {
    const review = await createReview(
      {
        runId: ctx.runId,
        stageName: stage.name,
        round,
        type: 'stage',
        lastAssistantMessage: currentResult.lastAssistantMessage,
        planMarkdown: currentResult.planMarkdown,
      },
      deps,
    );

    updateRunStatus(ctx.runId, 'awaiting_review');

    const hookToken = `review:${review.id}`;
    using hook = reviewDecisionHook.create({ token: hookToken });
    const decision = await hook;

    if (decision.action === 'approve') {
      // Update review status
      const db = getDb();
      db.update(schema.reviews)
        .set({ status: 'approved' })
        .where(eq(schema.reviews.id, review.id))
        .run();
      return currentResult;
    }

    // ── request_changes: comments embedded in next stage prompt ────────
    round += 1;

    currentResult = await executeStage(
      {
        runId: ctx.runId,
        stage,
        stageIndex: -1,
        round,
        isFirstStage: false,
        previousResult: null,
        requestChangesComments: decision.comments as ReviewComment[],
      },
      deps,
    );

    if (currentResult.status === 'failed') {
      currentResult = await handleStageFailure(ctx, stage, currentResult, -1, deps);
      if (currentResult.status === 'failed') {
        return currentResult;
      }
    }
  }
}

// --- Finalization sub-flow ----------------------------------------------- //

async function handleFinalization(
  ctx: PipelineContext,
  deps: PipelineDeps,
): Promise<void> {
  updateRunStatus(ctx.runId, 'finalizing');

  const result = await finalize(
    { runId: ctx.runId, targetBranch: ctx.targetBranch },
    deps,
  );

  if (result.conflict) {
    updateRunStatus(ctx.runId, 'awaiting_conflict_resolution');

    const hookToken = `conflict:${ctx.runId}:finalize:${Date.now()}`;
    using hook = conflictResolutionHook.create({ token: hookToken });
    const decision = await hook;

    if (decision.action === 'cancel') {
      updateRunStatus(ctx.runId, 'failed');
      await deps.sessionManager.stop(ctx.runId);
      return;
    }

    // Retry finalization — user resolved the conflict externally
    const retryResult = await finalize(
      { runId: ctx.runId, targetBranch: ctx.targetBranch },
      deps,
    );

    if (retryResult.conflict) {
      // Recursive resolution
      await handleFinalization(ctx, deps);
    }
  }
}

// --- DB helpers (synchronous via better-sqlite3) ------------------------- //

function loadContext(runId: string): PipelineContext {
  const db = getDb();

  const run = db
    .select()
    .from(schema.workflowRuns)
    .where(eq(schema.workflowRuns.id, runId))
    .get();

  if (!run) throw new Error(`Workflow run ${runId} not found`);

  const template = db
    .select()
    .from(schema.workflowTemplates)
    .where(eq(schema.workflowTemplates.id, run.workflowTemplateId))
    .get();

  if (!template) throw new Error(`Workflow template ${run.workflowTemplateId} not found`);

  const stages: WorkflowStage[] = JSON.parse(template.stages);

  return {
    runId,
    projectId: run.projectId,
    agentDefinitionId: run.agentDefinitionId,
    description: run.description ?? '',
    baseBranch: run.baseBranch ?? 'main',
    targetBranch: run.targetBranch ?? run.baseBranch ?? 'main',
    credentialSetId: run.credentialSetId,
    stages,
  };
}

function getRunRecord(runId: string) {
  const db = getDb();
  return db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get();
}

function getRunModel(runId: string): string | null {
  const run = getRunRecord(runId);
  return run?.model ?? null;
}

function getProject(projectId: string) {
  const db = getDb();
  return db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get();
}

function getAgentDef(agentDefinitionId: string) {
  const db = getDb();
  const agent = db
    .select()
    .from(schema.agentDefinitions)
    .where(eq(schema.agentDefinitions.id, agentDefinitionId))
    .get();
  if (!agent) throw new Error(`Agent definition ${agentDefinitionId} not found`);
  return {
    commandTemplate: agent.commandTemplate,
    dockerImage: agent.dockerImage ?? undefined,
  };
}

function updateRunStatus(runId: string, status: string): void {
  const db = getDb();
  db.update(schema.workflowRuns)
    .set({ status })
    .where(eq(schema.workflowRuns.id, runId))
    .run();
}

function updateCurrentStage(runId: string, stageName: string): void {
  const db = getDb();
  db.update(schema.workflowRuns)
    .set({ currentStage: stageName })
    .where(eq(schema.workflowRuns.id, runId))
    .run();
}

function getCurrentRound(runId: string, stageName: string): number {
  const db = getDb();
  const exec = db
    .select({ round: schema.stageExecutions.round })
    .from(schema.stageExecutions)
    .where(
      and(
        eq(schema.stageExecutions.workflowRunId, runId),
        eq(schema.stageExecutions.stageName, stageName),
      ),
    )
    .orderBy(desc(schema.stageExecutions.round))
    .limit(1)
    .get();
  return exec?.round ?? 0;
}

function markStageSkipped(runId: string, stageName: string): void {
  const db = getDb();
  const currentRound = getCurrentRound(runId, stageName);
  db.update(schema.stageExecutions)
    .set({ status: 'skipped' })
    .where(
      and(
        eq(schema.stageExecutions.workflowRunId, runId),
        eq(schema.stageExecutions.stageName, stageName),
        eq(schema.stageExecutions.round, currentRound),
      ),
    )
    .run();
}
