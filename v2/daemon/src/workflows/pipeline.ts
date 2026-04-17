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
  getRunStatus,
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
  persistSplitConfig,
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
import {
  stageFailedToken,
  reviewToken,
  proposalsToken,
  parallelToken,
  finalizeConflictToken,
  consolidateConflictToken,
} from './hookTokens.js';

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
  acpClient?: ReturnType<typeof import('../services/acp-client.js').createAcpClient>;
  streamingService?: typeof import('../services/streaming-service.js');
  sandboxService?: import('../services/sandbox.js').SandboxService;
}

// PipelineContext and WorkflowStage imported from ./steps/pipeline-db.js

interface FailureDecisionResult extends ExecuteStageOutput {
  action?: 'skip';
}

interface SplitResult {
  consolidationSummary: string;
  mergedDiffStats: string | null;
}

// Snapshot of the split decision, mirrored from `shared/SplitConfigSnapshot`.
// Defined inline to avoid importing zod-validated types into the
// "use workflow" module.
interface SplitConfigSnapshot {
  sourceStageName: string;
  sourceReviewId: string;
  triggeredAt: string;
  splitterPromptTemplate: string;
  extraDescription: string;
  effectiveSplitterPrompt: string;
  postSplitStages: WorkflowStage[];
  skippedTemplateStages: string[];
}

// Outcome from the review gate. `split_completed` means the entire run
// (including post-split stages and finalize) was already driven to a
// terminal state inside the split sub-pipeline, and the main loop must
// stop iterating the original template stages.
type ReviewGateOutcome =
  | { kind: 'approved'; result: ExecuteStageOutput }
  | { kind: 'cancelled' }
  | { kind: 'split_completed' };

// ── Pipeline ─────────────────────────────────────────────────────────

export async function runWorkflowPipeline(input: PipelineInput) {
  "use workflow";

  const ctx = await loadPipelineContext(input.runId);

  try {
    await runPipelineBody(ctx);
  } catch (err) {
    // Unhandled error (e.g. provisioning failure after retries exhausted).
    // Only force 'failed' if the run isn't already in a terminal state
    // (rubber-duck GPT H2 — preserve 'cancelled'/'completed' set by inner
    // paths like waitForChildren cancel or consolidation cancel).
    const currentStatus = await getRunStatus(ctx.runId);
    const terminal = new Set(['completed', 'failed', 'cancelled']);
    if (!currentStatus || !terminal.has(currentStatus)) {
      await updateRunStatus(ctx.runId, 'failed');
    }
    await stopSession({ runId: ctx.runId });
    throw err; // Re-throw so the workflow runtime records the failure
  }
}

async function runPipelineBody(ctx: PipelineContext) {
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
      ghAccount: ctx.ghAccount,
    });
  }

  let previousResult: ExecuteStageOutput | null = null;

  for (let i = 0; i < ctx.stages.length; i++) {
    const stage = ctx.stages[i];
    const isFinal = i === ctx.stages.length - 1;

    await updateRunStatus(ctx.runId, 'running');
    await updateCurrentStage(ctx.runId, stage.name);

    // ── 1. Execute stage ──────────────────────────────────────────────
    let result = await executeStage({
      runId: ctx.runId,
      stage,
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
        continue;
      }
      if (decision.status === 'failed') {
        await updateRunStatus(ctx.runId, 'failed');
        await stopSession({ runId: ctx.runId });
        return;
      }
      result = decision;
    }

    // ── 3. Review gate (which may branch into the ad-hoc split flow) ──
    if (stage.reviewRequired) {
      const outcome = await handleReviewGate(ctx, stage, result, i);
      if (outcome.kind === 'cancelled') {
        await stopSession({ runId: ctx.runId });
        return;
      }
      if (outcome.kind === 'split_completed') {
        // Split sub-pipeline ran post-split stages and finalized; we must
        // NOT continue iterating the original template's remaining stages.
        return;
      }
      result = outcome.result;
    }

    // ── 4. Finalization (last stage) ──────────────────────────────────
    if (isFinal) {
      await handleFinalization(ctx);
    }

    previousResult = result;
  }

  // ── 5. Terminal state ───────────────────────────────────────────────
  // Only mark completed from the 'finalizing' state; respect
  // awaiting_conflict_resolution / failed / cancelled set by inner paths
  // (rubber-duck GPT H3).
  const postFinalStatus = await getRunStatus(ctx.runId);
  if (postFinalStatus === 'finalizing') {
    await updateRunStatus(ctx.runId, 'completed');
  }
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

  const hookToken = stageFailedToken(ctx.runId, stage.name);
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
  stageIndex: number,
): Promise<ReviewGateOutcome> {
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

    const hookToken = reviewToken(review.id);
    using hook = reviewDecisionHook.create({ token: hookToken });
    const decision = await hook;

    if (decision.action === 'approve') {
      await updateReviewStatus(review.id, 'approved');
      return { kind: 'approved', result: currentResult };
    }

    if (decision.action === 'cancel') {
      await updateRunStatus(ctx.runId, 'cancelled');
      return { kind: 'cancelled' };
    }

    if (decision.action === 'split') {
      // Snapshot was resolved + persisted by the route handler; we trust
      // what's in the hook payload (durable + audit-friendly).
      // Defensive: persist again in case the route was an older build.
      await persistSplitConfig(ctx.runId, decision.splitConfig);
      await updateReviewStatus(review.id, 'approved');
      await runSplitSubPipeline(ctx, decision.splitConfig as SplitConfigSnapshot, stageIndex);
      return { kind: 'split_completed' };
    }

    // ── request_changes: comments embedded in next stage prompt ────────
    round += 1;

    currentResult = await executeStage({
      runId: ctx.runId,
      stage,
      stageIndex,
      round,
      isFirstStage: false,
      previousResult: null,
      requestChangesComments: decision.comments as ReviewComment[],
    });

    if (currentResult.status === 'failed') {
      const failureDecision = await handleStageFailure(ctx, stage, currentResult, stageIndex);
      if (failureDecision.status === 'failed') {
        await updateRunStatus(ctx.runId, 'failed');
        return { kind: 'cancelled' };
      }
      currentResult = failureDecision;
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

    const hookToken = finalizeConflictToken(ctx.runId);
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

// --- Ad-hoc split sub-pipeline ------------------------------------------- //

/**
 * Driven by the user clicking "Split" on a stage review (rubber-duck #1):
 * the route handler resolves a SplitConfigSnapshot from settings + user
 * input and embeds it in the hook resume payload. This function then runs:
 *
 *   1. Splitter agent (synthetic stage `__splitter__:${sourceStageName}`,
 *      MCP toolset enabled). On failure → stage_failed (retry/cancel).
 *      On zero proposals extracted → stage_failed reason `no_proposals`.
 *   2. Existing proposal review hook → launchChildren → waitForChildren.
 *   3. Consolidate (merge child branches; conflict resolution if needed).
 *   4. Consolidation review (approve-only).
 *   5. consolidateFinish (ff_parent + cleanup).
 *   6. Run each post-split stage from the snapshot via executeStage +
 *      handleReviewGate (no further split allowed: validated server-side).
 *   7. handleFinalization → completed.
 *
 * After this returns, the parent pipeline must NOT continue iterating
 * the original template's remaining stages — the run is already in a
 * terminal state.
 */
async function runSplitSubPipeline(
  ctx: PipelineContext,
  splitConfig: SplitConfigSnapshot,
  sourceStageIndex: number,
): Promise<void> {
  const splitterStageName = `__splitter__:${splitConfig.sourceStageName}`;
  const splitterStage: WorkflowStage = {
    name: splitterStageName,
    splittable: false,
    promptTemplate: splitConfig.effectiveSplitterPrompt,
    reviewRequired: false,
    autoAdvance: true,
    freshSession: false,
  };

  await updateCurrentStage(ctx.runId, splitterStageName);
  await updateRunStatus(ctx.runId, 'running');

  // ── 1. Splitter agent execution (with retry-on-failure semantics) ──
  let splitterResult = await executeStage({
    runId: ctx.runId,
    stage: {
      name: splitterStage.name,
      promptTemplate: splitterStage.promptTemplate,
      freshSession: splitterStage.freshSession,
      model: splitterStage.model,
      requiresSplitMcp: true,
    },
    stageIndex: sourceStageIndex,
    round: 1,
    isFirstStage: false,
    previousResult: null,
    requestChangesComments: null,
  });

  if (splitterResult.status === 'failed') {
    const decision = await handleStageFailure(ctx, splitterStage, splitterResult, sourceStageIndex);
    if (decision.action === 'skip') {
      // Skipping the splitter is meaningless — there's nothing downstream
      // in the template that we still want to run. Treat as cancel.
      await updateRunStatus(ctx.runId, 'cancelled');
      await stopSession({ runId: ctx.runId });
      return;
    }
    if (decision.status === 'failed') {
      await updateRunStatus(ctx.runId, 'failed');
      await stopSession({ runId: ctx.runId });
      return;
    }
    splitterResult = decision;
  }

  // ── 2. Extract proposals; zero → stage_failed reason no_proposals ──
  const proposalRecords = await extractProposals({
    runId: ctx.runId,
    stageName: splitterStageName,
    agentOutput: splitterResult.lastAssistantMessage ?? '',
  });

  if (proposalRecords.length === 0) {
    // Surface as stage_failed so the user gets retry/cancel UX. Reuse the
    // splitter stage so retry re-runs the splitter against the same
    // snapshot.
    const noPropsResult: ExecuteStageOutput = {
      status: 'failed',
      lastAssistantMessage: splitterResult.lastAssistantMessage,
      planMarkdown: null,
      error: 'Splitter produced no proposals (reason: no_proposals)',
    };
    const decision = await handleStageFailure(ctx, splitterStage, noPropsResult, sourceStageIndex);
    if (decision.action === 'skip' || decision.status === 'failed') {
      await updateRunStatus(ctx.runId, decision.action === 'skip' ? 'cancelled' : 'failed');
      await stopSession({ runId: ctx.runId });
      return;
    }
    // Retry succeeded: the splitter ran again. Recursive entry to re-run
    // the same proposal extraction + downstream steps with the updated
    // last message. Read the latest assistant output from the retry.
    const retryProposals = await extractProposals({
      runId: ctx.runId,
      stageName: splitterStageName,
      agentOutput: decision.lastAssistantMessage ?? '',
    });
    if (retryProposals.length === 0) {
      await updateRunStatus(ctx.runId, 'failed');
      await stopSession({ runId: ctx.runId });
      return;
    }
    proposalRecords.push(...retryProposals);
  }

  // ── 3. Proposal review hook ─────────────────────────────────────────
  await updateRunStatus(ctx.runId, 'awaiting_proposals');

  const propHookToken = proposalsToken(ctx.runId);
  using proposalHook = proposalReviewHook.create({ token: propHookToken });
  const proposalDecision = await proposalHook;

  if (proposalDecision.proposalIds.length === 0) {
    // User closed/cancelled the proposal review. Treat as cancel.
    await updateRunStatus(ctx.runId, 'cancelled');
    await stopSession({ runId: ctx.runId });
    return;
  }

  // ── 4. Launch children + wait ───────────────────────────────────────
  const { groupId, childRunIds } = await launchChildren({
    parentRunId: ctx.runId,
    selectedProposalIds: proposalDecision.proposalIds,
    projectId: ctx.projectId,
    agentDefinitionId: ctx.agentDefinitionId,
    credentialSetId: ctx.credentialSetId,
    ghAccount: ctx.ghAccount,
  });

  await updateRunStatus(ctx.runId, 'waiting_for_children');
  await waitForChildren(ctx, groupId, childRunIds);

  // ── 5. Consolidate ──────────────────────────────────────────────────
  await updateRunStatus(ctx.runId, 'running');

  const consolidationMerge = await consolidate({
    parentRunId: ctx.runId,
    parallelGroupId: groupId,
  });

  if (consolidationMerge.conflict) {
    await handleConsolidationConflict(ctx, groupId, consolidationMerge);
  }

  // ── 6. Consolidation review (approve-only) ──────────────────────────
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

  const consHookToken = reviewToken(consReview.id);
  using consHook = reviewDecisionHook.create({ token: consHookToken });
  const consDecision = await consHook;

  if (consDecision.action !== 'approve') {
    await updateRunStatus(ctx.runId, 'cancelled');
    await stopSession({ runId: ctx.runId });
    throw new Error(
      'Consolidation reviews only support approve. ' +
      'Cancel and re-run failed children, or start a new split.',
    );
  }

  // ── 7. consolidateFinish (ff_parent + cleanup) ──────────────────────
  await consolidateFinish({ parentRunId: ctx.runId, parallelGroupId: groupId });

  // ── 8. Run post-split stages from the snapshot ──────────────────────
  // After consolidation, agent context shifts entirely (children merged a
  // bunch of code we never saw). Force freshSession on the first
  // post-split stage so the agent loads the new state.
  let postPrev: ExecuteStageOutput | null = {
    status: 'completed',
    lastAssistantMessage: [
      consReview.aiSummary ?? 'Consolidation completed.',
      `\nMerged children: ${childTitleList.join(', ')}`,
    ].join('\n'),
    planMarkdown: null,
  };

  for (let i = 0; i < splitConfig.postSplitStages.length; i++) {
    const stage = splitConfig.postSplitStages[i];
    const isFinal = i === splitConfig.postSplitStages.length - 1;

    await updateRunStatus(ctx.runId, 'running');
    await updateCurrentStage(ctx.runId, stage.name);

    const effectiveStage: WorkflowStage = i === 0
      ? { ...stage, freshSession: true }
      : stage;

    let result = await executeStage({
      runId: ctx.runId,
      stage: effectiveStage,
      stageIndex: sourceStageIndex + 1 + i,
      round: 1,
      isFirstStage: false,
      previousResult: postPrev,
      requestChangesComments: null,
    });

    if (result.status === 'failed') {
      const decision = await handleStageFailure(ctx, stage, result, sourceStageIndex + 1 + i);
      if (decision.action === 'skip') {
        postPrev = null;
        continue;
      }
      if (decision.status === 'failed') {
        await updateRunStatus(ctx.runId, 'failed');
        await stopSession({ runId: ctx.runId });
        return;
      }
      result = decision;
    }

    if (stage.reviewRequired) {
      // Post-split stages are validated as not-splittable by settings
      // schema, so handleReviewGate will only see approve/request_changes/cancel.
      const outcome = await handleReviewGate(ctx, stage, result, sourceStageIndex + 1 + i);
      if (outcome.kind === 'cancelled') {
        await stopSession({ runId: ctx.runId });
        return;
      }
      // 'split_completed' is impossible here (stage is not splittable),
      // but defend defensively:
      if (outcome.kind === 'split_completed') {
        // Already finalized inside; nothing to do.
        return;
      }
      result = outcome.result;
    }

    if (isFinal) {
      await handleFinalization(ctx);
    }

    postPrev = result;
  }

  // ── 9. If no post-split stages, finalize directly ───────────────────
  if (splitConfig.postSplitStages.length === 0) {
    await handleFinalization(ctx);
  }

  // Only mark completed if finalization actually succeeded. handleFinalization
  // may park the run in 'awaiting_conflict_resolution' or 'failed' on conflict
  // error paths (rubber-duck GPT H3). Respect any terminal or awaiting status
  // it set; only flip to 'completed' from the in-progress 'finalizing' state.
  const postFinalStatus = await getRunStatus(ctx.runId);
  if (postFinalStatus === 'finalizing') {
    await updateRunStatus(ctx.runId, 'completed');
  }
  await stopSession({ runId: ctx.runId });
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

    const hookToken = parallelToken(ctx.runId);
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
  const hookToken = consolidateConflictToken(ctx.runId, groupId);
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
