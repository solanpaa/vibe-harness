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
import {
  loadPipelineContext,
  updateRunStatus,
  updateCurrentStage,
  getRunRecord,
  getRunModel,
  getProject,
  getAgentDef,
  getCurrentRound,
  markStageSkipped,
  updateReviewStatus,
  getChildStatuses,
  getChildTitles,
  retryChildWorkflowRun,
  cancelAllChildRuns,
  provisionSession,
  stopSession,
  type PipelineContext,
  type WorkflowStage,
} from './steps/pipeline-db.js';

import {
  reviewDecisionHook,
  stageFailedHook,
  proposalReviewHook,
  parallelCompletionHook,
  conflictResolutionHook,
  type ReviewComment,
} from './hooks.js';

import { executeStage, type ExecuteStageOutput } from './steps/execute-stage.js';
import { createReview } from './steps/create-review.js';
import { finalize } from './steps/finalize.js';
import { extractProposals } from './steps/extract-proposals.js';
import { launchChildren } from './steps/launch-children.js';
import { consolidate } from './steps/consolidate.js';
import { consolidateFinish } from './steps/consolidate-finish.js';

// ── Types ────────────────────────────────────────────────────────────

export interface PipelineInput {
  runId: string;
}

export interface PipelineDeps {
  sessionManager: import('../services/session-manager.js').SessionManager;
  reviewService: import('../services/review-service.js').ReviewService;
  worktreeService: import('../services/worktree.js').WorktreeService;
  proposalService: import('../services/proposal-service.js').ProposalService;
  branchNamer: import('../services/branch-namer.js').BranchNamer;
}

// PipelineContext and WorkflowStage imported from ./steps/pipeline-db.js

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

  const ctx = await loadPipelineContext(input.runId);

  await updateRunStatus(ctx.runId, 'provisioning');

  // Provision session for the first stage (runs as a step with Node.js access)
  const firstStage = ctx.stages[0];
  if (firstStage) {
    const resolvedModel = firstStage.model ?? (await getRunModel(ctx.runId)) ?? undefined;
    await provisionSession({
      runId: ctx.runId,
      projectId: ctx.projectId,
      agentDefinitionId: ctx.agentDefinitionId,
      baseBranch: ctx.baseBranch,
      model: resolvedModel,
    });
  }

  let previousResult: ExecuteStageOutput | null = null;
  let splitResult: SplitResult | null = null;

  for (let i = 0; i < ctx.stages.length; i++) {
    const stage = ctx.stages[i];
    const isFinal = i === ctx.stages.length - 1;

    await updateRunStatus(ctx.runId, 'running');
    await updateCurrentStage(ctx.runId, stage.name);

    // Fix #6: After a split stage, force freshSession=true
    const effectiveFreshSession = splitResult != null ? true : stage.freshSession;
    const effectiveStage = { ...stage, freshSession: effectiveFreshSession };

    // ── 1. Execute stage ──────────────────────────────────────────────
    let result = await executeStage({
      runId: ctx.runId,
      stage: effectiveStage,
      stageIndex: i,
      round: 1,
      isFirstStage: i === 0,
      previousResult,
      requestChangesComments: null,
    });

    // ── 2. Handle stage failure ───────────────────────────────────────
    if (result.status === 'failed') {
      const decision = await handleStageFailure(ctx, stage, result, i);

      if (decision.action === 'skip') {
        previousResult = null;
        splitResult = null;
        continue;
      }
      if (decision.status === 'failed') {
        await updateRunStatus(ctx.runId, 'failed');
        await stopSession({ runId: ctx.runId });
        return;
      }
      result = decision;
    }

    // ── 3. Split stage handling ───────────────────────────────────────
    if (stage.type === 'split') {
      splitResult = await handleSplitStage(ctx, stage, result, isFinal);
      previousResult = {
        status: 'completed',
        lastAssistantMessage: splitResult.consolidationSummary,
        planMarkdown: null,
      };
      continue;
    }

    // ── 4. Review gate (standard stages) ──────────────────────────────
    if (stage.reviewRequired) {
      result = await handleReviewGate(ctx, stage, result);
      if (result.status === 'failed') {
        await updateRunStatus(ctx.runId, 'failed');
        await stopSession({ runId: ctx.runId });
        return;
      }
    }

    // ── 5. Finalization (last stage) ──────────────────────────────────
    if (isFinal) {
      await handleFinalization(ctx);
    }

    previousResult = result;
    splitResult = null;
  }

  // ── 6. Terminal state ───────────────────────────────────────────────
  await updateRunStatus(ctx.runId, 'completed');
  await stopSession({ runId: ctx.runId });
}

// --- Stage failure sub-flow ---------------------------------------------- //

async function handleStageFailure(
  ctx: PipelineContext,
  stage: WorkflowStage,
  failedResult: ExecuteStageOutput,
  stageIndex: number,
): Promise<FailureDecisionResult> {
  await updateRunStatus(ctx.runId, 'stage_failed');

  const hookToken = `failed:${ctx.runId}:${stage.name}`;
  using hook = stageFailedHook.create({ token: hookToken });
  const decision = await hook;

  switch (decision.action) {
    case 'retry': {
      const currentRound = await getCurrentRound(ctx.runId, stage.name);
      const retryResult = await executeStage({
        runId: ctx.runId,
        stage,
        stageIndex,
        round: currentRound + 1,
        isFirstStage: false,
        previousResult: null,
        requestChangesComments: null,
        retryError: failedResult.error,
      });

      if (retryResult.status === 'failed') {
        return handleStageFailure(ctx, stage, retryResult, stageIndex);
      }
      return retryResult;
    }

    case 'skip':
      await markStageSkipped(ctx.runId, stage.name);
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
): Promise<ExecuteStageOutput> {
  let currentResult = result;
  let round = 1;

  while (true) {
    const review = await createReview({
      runId: ctx.runId,
      stageName: stage.name,
      round,
      type: 'stage',
      lastAssistantMessage: currentResult.lastAssistantMessage,
      planMarkdown: currentResult.planMarkdown,
    });

    await updateRunStatus(ctx.runId, 'awaiting_review');

    const hookToken = `review:${review.id}`;
    using hook = reviewDecisionHook.create({ token: hookToken });
    const decision = await hook;

    if (decision.action === 'approve') {
      await updateReviewStatus(review.id, 'approved');
      return currentResult;
    }

    if (decision.action === 'cancel') {
      await updateRunStatus(ctx.runId, 'cancelled');
      return {
        status: 'failed',
        lastAssistantMessage: currentResult.lastAssistantMessage,
        planMarkdown: currentResult.planMarkdown,
        error: 'Workflow cancelled during review',
      };
    }

    // ── request_changes: comments embedded in next stage prompt ────────
    round += 1;

    currentResult = await executeStage({
      runId: ctx.runId,
      stage,
      stageIndex: -1,
      round,
      isFirstStage: false,
      previousResult: null,
      requestChangesComments: decision.comments as ReviewComment[],
    });

    if (currentResult.status === 'failed') {
      currentResult = await handleStageFailure(ctx, stage, currentResult, -1);
      if (currentResult.status === 'failed') {
        return currentResult;
      }
    }
  }
}

// --- Finalization sub-flow ----------------------------------------------- //

async function handleFinalization(
  ctx: PipelineContext,
): Promise<void> {
  await updateRunStatus(ctx.runId, 'finalizing');

  const result = await finalize({ runId: ctx.runId, targetBranch: ctx.targetBranch });

  if (result.conflict) {
    await updateRunStatus(ctx.runId, 'awaiting_conflict_resolution');

    const hookToken = `conflict:${ctx.runId}:finalize`;
    using hook = conflictResolutionHook.create({ token: hookToken });
    const decision = await hook;

    if (decision.action === 'cancel') {
      await updateRunStatus(ctx.runId, 'failed');
      await stopSession({ runId: ctx.runId });
      return;
    }

    // Retry finalization — user resolved the conflict externally
    const retryResult = await finalize({ runId: ctx.runId, targetBranch: ctx.targetBranch });

    if (retryResult.conflict) {
      await handleFinalization(ctx);
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
): Promise<SplitResult> {
  // ── 1. Extract proposals from agent output ──────────────────────────
  const proposalRecords = await extractProposals({
    runId: ctx.runId,
    stageName: stage.name,
    agentOutput: splitStageResult.lastAssistantMessage ?? '',
  });

  // ── 2. Proposal review hook — user edits/selects proposals ──────────
  await updateRunStatus(ctx.runId, 'awaiting_proposals');

  const hookToken = `proposals:${ctx.runId}`;
  using proposalHook = proposalReviewHook.create({ token: hookToken });
  const proposalDecision = await proposalHook;

  // ── 3. Launch child workflow runs ───────────────────────────────────
  const { groupId, childRunIds } = await launchChildren({
    parentRunId: ctx.runId,
    selectedProposalIds: proposalDecision.proposalIds,
    projectId: ctx.projectId,
    agentDefinitionId: ctx.agentDefinitionId,
    credentialSetId: ctx.credentialSetId,
  });

  await updateRunStatus(ctx.runId, 'waiting_for_children');

  // ── 4. Wait for all children to reach terminal state ────────────────
  await waitForChildren(ctx, groupId, childRunIds);

  // ── 5. Consolidation phase 1: merge child branches ──────────────────
  // Fix #5: consolidate() now ONLY performs snapshot_parent + merge_children.
  await updateRunStatus(ctx.runId, 'running');

  const consolidationMerge = await consolidate({
    parentRunId: ctx.runId,
    parallelGroupId: groupId,
  });

  if (consolidationMerge.conflict) {
    await handleConsolidationConflict(ctx, groupId, consolidationMerge);
  }

  // ── 6. Consolidation review (SAD §5.3.5) ────────────────────────────
  // Fix #14: Pass consolidation context so the review has meaningful content
  const childTitleList = await getChildTitles(childRunIds);
  const consolidationContext = [
    `Consolidated ${childTitleList.length} child workflow branches:`,
    ...childTitleList.map((t, i) => `  ${i + 1}. ${t}`),
    consolidationMerge.mergedFiles
      ? `\nFiles modified: ${consolidationMerge.mergedFiles}`
      : '',
  ].join('\n');

  const consReview = await createReview({
    runId: ctx.runId,
    stageName: null,
    round: 1,
    type: 'consolidation',
    lastAssistantMessage: consolidationContext,
    planMarkdown: null,
  });

  await updateRunStatus(ctx.runId, 'awaiting_review');

  // Fix #11: Consolidation reviews only support 'approve'.
  const consHookToken = `review:${consReview.id}`;
  using consHook = reviewDecisionHook.create({ token: consHookToken });
  const consDecision = await consHook;

  if (consDecision.action !== 'approve') {
    await updateRunStatus(ctx.runId, 'cancelled');
    await stopSession({ runId: ctx.runId });
    throw new Error(
      'request_changes is not supported for consolidation reviews. ' +
      'Cancel and re-run failed children, or start a new split.',
    );
  }

  // ── 7. Consolidation phase 2: ff_parent + cleanup (ONLY after approval) ─
  await consolidateFinish({ parentRunId: ctx.runId, parallelGroupId: groupId });

  // ── 8. Build consolidation summary for post-split context ───────────
  const consolidationSummary = [
    consReview.aiSummary ?? 'Consolidation completed.',
    `\nMerged children: ${childTitleList.join(', ')}`,
  ].join('\n');

  // ── 9. Finalize if this was the last stage ──────────────────────────
  if (isFinal) {
    await handleFinalization(ctx);
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
    const statuses = await getChildStatuses(childRunIds);

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
    await updateRunStatus(ctx.runId, 'children_completed_with_failures');

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
          await retryChildWorkflowRun(childId);
        }
        continue;
      }

      case 'cancel':
        await cancelAllChildRuns(childRunIds);
        await updateRunStatus(ctx.runId, 'cancelled');
        throw new Error('Parallel group cancelled by user');
    }
  }
}

// --- Consolidation conflict sub-flow ------------------------------------- //

async function handleConsolidationConflict(
  ctx: PipelineContext,
  groupId: string,
  consolidationResult: { conflict: boolean; conflictChildId?: string; mergedFiles?: string },
): Promise<void> {
  await updateRunStatus(ctx.runId, 'awaiting_conflict_resolution');

  // Stable, durable hook token — no Date.now() which breaks on replay
  const hookToken = `conflict:${ctx.runId}:${groupId}:consolidate`;
  using hook = conflictResolutionHook.create({ token: hookToken });
  const decision = await hook;

  if (decision.action === 'cancel') {
    await updateRunStatus(ctx.runId, 'failed');
    throw new Error('Consolidation cancelled due to unresolved conflict');
  }

  // decision.action === 'retry': user resolved externally, re-run consolidation
  const retryResult = await consolidate({
    parentRunId: ctx.runId,
    parallelGroupId: groupId,
  });

  if (retryResult.conflict) {
    await handleConsolidationConflict(ctx, groupId, retryResult);
  }
}
