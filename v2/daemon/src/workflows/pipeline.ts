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
import { extractProposals, type ExtractProposalsDeps } from './steps/extract-proposals.js';
import { launchChildren, type LaunchChildrenDeps } from './steps/launch-children.js';
import { consolidate, type ConsolidateDeps } from './steps/consolidate.js';
import { consolidateFinish, type ConsolidateFinishDeps } from './steps/consolidate-finish.js';

// ── Types ────────────────────────────────────────────────────────────

export interface PipelineInput {
  runId: string;
}

// Module-level deps holder — initialized by setPipelineDeps() at startup.
// Pipeline resolves deps here instead of receiving them via workflow input
// (which must be serializable for replay).
let _pipelineDeps: PipelineDeps | null = null;

export async function setPipelineDeps(deps: PipelineDeps): Promise<void> {
  _pipelineDeps = deps;
}

function resolveDeps(): PipelineDeps {
  if (!_pipelineDeps) {
    throw new Error('Pipeline deps not initialized. Call setPipelineDeps() at startup.');
  }
  return _pipelineDeps;
}

export interface PipelineDeps extends ExecuteStageDeps, CreateReviewDeps, FinalizeDeps, ExtractProposalsDeps, LaunchChildrenDeps, ConsolidateDeps, ConsolidateFinishDeps {}

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

  const deps = resolveDeps();
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
      splitResult = await handleSplitStage(ctx, stage, result, isFinal, deps);
      previousResult = {
        status: 'completed',
        lastAssistantMessage: splitResult.consolidationSummary,
        planMarkdown: null,
      };
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

  const hookToken = `failed:${ctx.runId}:${stage.name}`;
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

    if (decision.action === 'cancel') {
      updateRunStatus(ctx.runId, 'cancelled');
      return {
        status: 'failed',
        lastAssistantMessage: currentResult.lastAssistantMessage,
        planMarkdown: currentResult.planMarkdown,
        error: 'Workflow cancelled during review',
      };
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

    const hookToken = `conflict:${ctx.runId}:finalize`;
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

// --- Split stage sub-flow ------------------------------------------------ //

/**
 * Full split lifecycle: extract proposals → hook → launch children →
 * wait → consolidate (merge only) → review → on approve: ff_parent + cleanup.
 *
 * Fix #5: Consolidation is split into two steps:
 *   (a) consolidate — merges child branches into consolidation branch
 *   (b) consolidateFinish — ff_parent + cleanup, called ONLY after review approval
 *
 * Fix #10: Returns SplitResult (consolidation summary) instead of void,
 * so the main loop can use it as post-split freshSession context.
 *
 * Fix #14: Passes consolidation summary (child list + merged files) when
 * creating the consolidation review so it has meaningful content.
 */
async function handleSplitStage(
  ctx: PipelineContext,
  stage: WorkflowStage,
  splitStageResult: ExecuteStageOutput,
  isFinal: boolean,
  deps: PipelineDeps,
): Promise<SplitResult> {
  // ── 1. Extract proposals from agent output ──────────────────────────
  const proposalRecords = await extractProposals(
    {
      runId: ctx.runId,
      stageName: stage.name,
      agentOutput: splitStageResult.lastAssistantMessage ?? '',
    },
    deps,
  );

  // ── 2. Proposal review hook — user edits/selects proposals ──────────
  updateRunStatus(ctx.runId, 'awaiting_proposals');

  const hookToken = `proposals:${ctx.runId}`;
  using proposalHook = proposalReviewHook.create({ token: hookToken });
  const proposalDecision = await proposalHook;

  // ── 3. Launch child workflow runs ───────────────────────────────────
  const { groupId, childRunIds } = await launchChildren(
    {
      parentRunId: ctx.runId,
      selectedProposalIds: proposalDecision.proposalIds,
      projectId: ctx.projectId,
      agentDefinitionId: ctx.agentDefinitionId,
      credentialSetId: ctx.credentialSetId,
    },
    deps,
  );

  updateRunStatus(ctx.runId, 'waiting_for_children');

  // ── 4. Wait for all children to reach terminal state ────────────────
  await waitForChildren(ctx, groupId, childRunIds);

  // ── 5. Consolidation phase 1: merge child branches ──────────────────
  // Fix #5: consolidate() now ONLY performs snapshot_parent + merge_children.
  updateRunStatus(ctx.runId, 'running');

  const consolidationMerge = await consolidate(
    { parentRunId: ctx.runId, parallelGroupId: groupId },
    deps,
  );

  if (consolidationMerge.conflict) {
    await handleConsolidationConflict(ctx, groupId, consolidationMerge, deps);
  }

  // ── 6. Consolidation review (SAD §5.3.5) ────────────────────────────
  // Fix #14: Pass consolidation context so the review has meaningful content
  const childTitles = getChildTitles(childRunIds);
  const consolidationContext = [
    `Consolidated ${childTitles.length} child workflow branches:`,
    ...childTitles.map((t, i) => `  ${i + 1}. ${t}`),
    consolidationMerge.mergedFiles
      ? `\nFiles modified: ${consolidationMerge.mergedFiles}`
      : '',
  ].join('\n');

  const consReview = await createReview(
    {
      runId: ctx.runId,
      stageName: null,
      round: 1,
      type: 'consolidation',
      lastAssistantMessage: consolidationContext,
      planMarkdown: null,
    },
    deps,
  );

  updateRunStatus(ctx.runId, 'awaiting_review');

  // Fix #11: Consolidation reviews only support 'approve'.
  const consHookToken = `review:${consReview.id}`;
  using consHook = reviewDecisionHook.create({ token: consHookToken });
  const consDecision = await consHook;

  if (consDecision.action !== 'approve') {
    updateRunStatus(ctx.runId, 'cancelled');
    await deps.sessionManager.stop(ctx.runId);
    throw new Error(
      'request_changes is not supported for consolidation reviews. ' +
      'Cancel and re-run failed children, or start a new split.',
    );
  }

  // ── 7. Consolidation phase 2: ff_parent + cleanup (ONLY after approval) ─
  await consolidateFinish(
    { parentRunId: ctx.runId, parallelGroupId: groupId },
    deps,
  );

  // ── 8. Build consolidation summary for post-split context ───────────
  const consolidationSummary = [
    consReview.aiSummary ?? 'Consolidation completed.',
    `\nMerged children: ${childTitles.join(', ')}`,
  ].join('\n');

  // ── 9. Finalize if this was the last stage ──────────────────────────
  if (isFinal) {
    await handleFinalization(ctx, deps);
  }

  return {
    consolidationSummary,
    mergedDiffStats: consolidationMerge.mergedFiles ?? null,
  };
}

// --- Parallel completion sub-flow ---------------------------------------- //

/**
 * Polls child run statuses. If all completed, proceeds immediately.
 * If mixed results, suspends via parallelCompletionHook (SAD §5.3.4).
 */
async function waitForChildren(
  ctx: PipelineContext,
  groupId: string,
  childRunIds: string[],
): Promise<void> {
  while (true) {
    const statuses = getChildStatuses(childRunIds);

    const allTerminal = statuses.every(
      (s) => s === 'completed' || s === 'failed' || s === 'cancelled',
    );

    if (!allTerminal) {
      // Fix #9: sleep() is a durable workflow primitive — persists state before
      // sleeping. On daemon crash + restart, resumes from the sleep point.
      await sleep(5_000);
      continue;
    }

    const allCompleted = statuses.every((s) => s === 'completed');

    if (allCompleted) {
      return; // Proceed directly to consolidation
    }

    // ── Mixed results: suspend for user decision ────────────────────
    updateRunStatus(ctx.runId, 'children_completed_with_failures');

    const hookToken = `parallel:${ctx.runId}`;
    using hook = parallelCompletionHook.create({ token: hookToken });
    const decision = await hook;

    switch (decision.action) {
      case 'consolidate_completed':
        // Proceed — consolidate step will filter to completed children only
        return;

      case 'retry': {
        // Restart failed children, loop back to wait
        for (const childId of decision.childRunIds ?? []) {
          retryChildRun(childId);
        }
        continue;
      }

      case 'cancel':
        cancelAllChildren(childRunIds);
        updateRunStatus(ctx.runId, 'cancelled');
        throw new Error('Parallel group cancelled by user');
    }
  }
}

// --- Consolidation conflict sub-flow ------------------------------------- //

async function handleConsolidationConflict(
  ctx: PipelineContext,
  groupId: string,
  consolidationResult: { conflict: boolean; conflictChildId?: string; mergedFiles?: string },
  deps: PipelineDeps,
): Promise<void> {
  updateRunStatus(ctx.runId, 'awaiting_conflict_resolution');

  // Stable, durable hook token — no Date.now() which breaks on replay
  const hookToken = `conflict:${ctx.runId}:${groupId}:consolidate`;
  using hook = conflictResolutionHook.create({ token: hookToken });
  const decision = await hook;

  if (decision.action === 'cancel') {
    updateRunStatus(ctx.runId, 'failed');
    throw new Error('Consolidation cancelled due to unresolved conflict');
  }

  // decision.action === 'retry': user resolved externally, re-run consolidation
  const retryResult = await consolidate(
    { parentRunId: ctx.runId, parallelGroupId: groupId },
    deps,
  );

  if (retryResult.conflict) {
    // Recursive
    await handleConsolidationConflict(ctx, groupId, retryResult, deps);
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

// --- Child run helpers --------------------------------------------------- //

function getChildStatuses(childRunIds: string[]): string[] {
  const db = getDb();
  return childRunIds.map((id) => {
    const run = db
      .select({ status: schema.workflowRuns.status })
      .from(schema.workflowRuns)
      .where(eq(schema.workflowRuns.id, id))
      .get();
    return run?.status ?? 'unknown';
  });
}

function getChildTitles(childRunIds: string[]): string[] {
  const db = getDb();
  return childRunIds.map((id) => {
    const run = db
      .select({ title: schema.workflowRuns.title })
      .from(schema.workflowRuns)
      .where(eq(schema.workflowRuns.id, id))
      .get();
    return run?.title ?? id.slice(0, 8);
  });
}

function retryChildRun(childRunId: string): void {
  const db = getDb();
  db.update(schema.workflowRuns)
    .set({ status: 'pending', completedAt: null })
    .where(eq(schema.workflowRuns.id, childRunId))
    .run();

  // Actually restart the child pipeline (fire-and-forget).
  // start() is imported from 'workflow/api' in the step modules;
  // we import it here to avoid circular deps at module level.
  import('workflow/api').then(({ start: startWorkflow }) => {
    startWorkflow(runWorkflowPipeline, [{ runId: childRunId }]);
  });
}

function cancelAllChildren(childRunIds: string[]): void {
  const db = getDb();
  for (const id of childRunIds) {
    const run = db
      .select({ status: schema.workflowRuns.status })
      .from(schema.workflowRuns)
      .where(eq(schema.workflowRuns.id, id))
      .get();

    if (run && !['completed', 'failed', 'cancelled'].includes(run.status)) {
      db.update(schema.workflowRuns)
        .set({ status: 'cancelled', completedAt: new Date().toISOString() })
        .where(eq(schema.workflowRuns.id, id))
        .run();
    }
  }
}
