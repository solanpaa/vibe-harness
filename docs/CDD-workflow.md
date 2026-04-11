# Vibe Harness v2 — Component Detailed Design: Workflow Engine

**Traces to:** SAD §5 (Workflow Orchestration Architecture), SRD §2.3–2.6

---

## 1. Main Workflow Pipeline (`workflows/pipeline.ts`)

The top-level durable workflow function. All stage sequencing, hook suspension, parallel fan-out/fan-in, and finalization live here. Steps are replay-safe — the `"use workflow"` runtime may re-execute this function from the beginning on daemon restart, replaying completed steps from the event log and resuming from the last suspension point (SAD §5.1).

```typescript
// workflows/pipeline.ts
"use workflow";

import { defineWorkflow } from "workflow/api";
import { db } from "../db";
import { workflowRuns, stageExecutions, parallelGroups, proposals } from "../db/schema";
import { eq, and } from "drizzle-orm";

import {
  reviewDecisionHook,
  stageFailedHook,
  proposalReviewHook,
  parallelCompletionHook,
  conflictResolutionHook,
} from "./hooks";

import { executeStage } from "./steps/execute-stage";
import { createReview } from "./steps/create-review";
import { injectComments } from "./steps/inject-comments";
import { extractProposals } from "./steps/extract-proposals";
import { launchChildren } from "./steps/launch-children";
import { consolidate } from "./steps/consolidate";
import { finalize } from "./steps/finalize";

// --- Types --------------------------------------------------------------- //

/** Input payload serialized by the route handler when calling start(). */
interface PipelineInput {
  runId: string;
}

/** Resolved from DB at pipeline start; carried through the loop. */
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

/** Parsed from workflowTemplates.stages JSON column (SAD §4.2). */
interface WorkflowStage {
  name: string;
  type: "standard" | "split";
  promptTemplate: string;
  reviewRequired: boolean;
  autoAdvance: boolean;
  freshSession: boolean;
}

/** Returned by executeStage step (see §3.1). */
interface StageResult {
  status: "completed" | "failed";
  lastAssistantMessage: string | null;
  planMarkdown: string | null;
  error?: string;
}

// --- Pipeline ------------------------------------------------------------ //

export const runWorkflowPipeline = defineWorkflow(
  async (input: PipelineInput) => {
    const ctx = await loadContext(input.runId);

    // Set status to 'provisioning' — sandbox + worktree creation happens
    // inside the first executeStage call (SAD §5.3, step 3).
    await updateRunStatus(ctx.runId, "provisioning");

    let previousResult: StageResult | null = null;

    for (let i = 0; i < ctx.stages.length; i++) {
      const stage = ctx.stages[i];
      const isFinal = i === ctx.stages.length - 1;

      await updateRunStatus(ctx.runId, "running");
      await updateCurrentStage(ctx.runId, stage.name);

      // ── 1. Execute stage (standard or split-generation phase) ───────
      // The step is idempotent: if a stageExecution record already exists
      // with status='completed' for this (runId, stageName, round), it
      // returns the cached result without re-sending the prompt (SAD §5.3).

      let result = await executeStage({
        runId: ctx.runId,
        stage,
        stageIndex: i,
        round: 1,
        isFirstStage: i === 0,
        previousResult,
        requestChangesComments: null,
      });

      // ── 2. Handle stage failure ─────────────────────────────────────
      // SAD §5.3.2: user can retry, skip, or cancel.
      if (result.status === "failed") {
        result = await handleStageFailure(ctx, stage, result, i);
        if (result.status === "failed") {
          // User chose 'cancel' or exhausted retries
          await updateRunStatus(ctx.runId, "failed");
          await stopSession(ctx.runId);
          return;
        }
        if (result === null as any) {
          // User chose 'skip' → proceed with null result
          previousResult = null;
          continue;
        }
      }

      // ── 3. Split stage handling ─────────────────────────────────────
      // SAD §5.3.3, §5.3.4, §5.3.5
      if (stage.type === "split") {
        await handleSplitStage(ctx, stage, result, isFinal);
        // After consolidation, subsequent stages get freshSession=true
        // with consolidation summary as context (SRD FR-S11).
        previousResult = result;
        continue;
      }

      // ── 4. Review gate (standard stages) ────────────────────────────
      // SAD §5.3.1: reviewRequired stages suspend for human review.
      if (stage.reviewRequired) {
        result = await handleReviewGate(ctx, stage, result);
      }

      // ── 5. Finalization (last stage approval) ───────────────────────
      // SAD §5.5.2: commit → rebase → merge → cleanup.
      if (isFinal) {
        await handleFinalization(ctx);
      }

      previousResult = result;
    }

    // ── 6. Terminal state ───────────────────────────────────────────────
    await updateRunStatus(ctx.runId, "completed");
    await stopSession(ctx.runId);
  }
);

// --- Stage failure sub-flow ---------------------------------------------- //

/**
 * Suspends the workflow via stageFailedHook until user decides (SAD §5.3.2).
 * Returns a new StageResult on retry success, or the original failure on
 * cancel. Returns null (typed as StageResult) for skip.
 */
async function handleStageFailure(
  ctx: PipelineContext,
  stage: WorkflowStage,
  failedResult: StageResult,
  stageIndex: number,
): Promise<StageResult> {
  await updateRunStatus(ctx.runId, "stage_failed");

  const hookToken = `failed:${ctx.runId}:${stage.name}`;
  const decision = await stageFailedHook.create({
    token: hookToken,
    data: {
      runId: ctx.runId,
      stageName: stage.name,
      error: failedResult.error ?? "Unknown error",
    },
  });

  switch (decision.action) {
    case "retry": {
      // SAD §5.3.2: send failure-aware message into conversation (FR-W14).
      // Round increments — execute-stage will create a new stageExecution.
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

      if (retryResult.status === "failed") {
        // Recursive: let user decide again
        return handleStageFailure(ctx, stage, retryResult, stageIndex);
      }
      return retryResult;
    }

    case "skip":
      // Mark the stage as skipped in DB; return a sentinel value.
      await markStageSkipped(ctx.runId, stage.name);
      return { status: "completed", lastAssistantMessage: null, planMarkdown: null } as any;

    case "cancel":
      return failedResult; // Caller checks status === 'failed' and terminates
  }
}

// --- Review gate sub-flow ------------------------------------------------ //

/**
 * Creates a review, suspends on reviewDecisionHook, and loops on
 * request_changes (SAD §5.3.1, SRD FR-R6–R8).
 */
async function handleReviewGate(
  ctx: PipelineContext,
  stage: WorkflowStage,
  result: StageResult,
): Promise<StageResult> {
  let currentResult = result;
  let round = 1;

  while (true) {
    // create-review is idempotent: UNIQUE(runId, stageName, round, type)
    const review = await createReview({
      runId: ctx.runId,
      stageName: stage.name,
      round,
      type: "stage",
      lastAssistantMessage: currentResult.lastAssistantMessage,
      planMarkdown: currentResult.planMarkdown,
    });

    await updateRunStatus(ctx.runId, "awaiting_review");

    const hookToken = `review:${review.id}`;
    const decision = await reviewDecisionHook.create({
      token: hookToken,
      data: { reviewId: review.id, runId: ctx.runId, stageName: stage.name },
    });

    if (decision.action === "approve") {
      return currentResult;
    }

    // ── request_changes: inject comments, re-execute same stage ─────
    // SAD §5.4: comments bundled as markdown, sent via sessionManager.continue()
    await injectComments({
      runId: ctx.runId,
      reviewId: review.id,
      comments: decision.comments,
    });

    round += 1;

    currentResult = await executeStage({
      runId: ctx.runId,
      stage,
      stageIndex: -1, // not used for continuation
      round,
      isFirstStage: false,
      previousResult: null,
      requestChangesComments: decision.comments,
    });

    if (currentResult.status === "failed") {
      // Delegate to failure handler; if it returns success, loop back to review
      currentResult = await handleStageFailure(ctx, stage, currentResult, -1);
      if (currentResult.status === "failed") {
        return currentResult; // propagate cancel
      }
    }
  }
}

// --- Split stage sub-flow ------------------------------------------------ //

/**
 * Full split lifecycle: extract proposals → hook → launch children →
 * wait → consolidate → review (SAD §5.3.3–5.3.5, SRD §2.5).
 */
async function handleSplitStage(
  ctx: PipelineContext,
  stage: WorkflowStage,
  splitResult: StageResult,
  isFinal: boolean,
): Promise<void> {
  // ── 1. Extract proposals from agent output ──────────────────────────
  const proposalRecords = await extractProposals({
    runId: ctx.runId,
    stageName: stage.name,
    agentOutput: splitResult.lastAssistantMessage ?? "",
  });

  // ── 2. Proposal review hook — user edits/selects proposals ──────────
  await updateRunStatus(ctx.runId, "awaiting_proposals");

  const proposalDecision = await proposalReviewHook.create({
    token: `proposals:${ctx.runId}`,
    data: {
      runId: ctx.runId,
      proposalIds: proposalRecords.map((p) => p.id),
    },
  });

  // ── 3. Launch child workflow runs ───────────────────────────────────
  // SAD §5.5.2: snapshot parent worktree, create child branches.
  const { groupId, childRunIds } = await launchChildren({
    parentRunId: ctx.runId,
    selectedProposalIds: proposalDecision.proposalIds,
    projectId: ctx.projectId,
    agentDefinitionId: ctx.agentDefinitionId,
    credentialSetId: ctx.credentialSetId,
  });

  await updateRunStatus(ctx.runId, "waiting_for_children");

  // ── 4. Wait for all children to reach terminal state ────────────────
  // Children are independent workflow runs started via start().
  // We poll until all are done, or suspend if mixed results (SAD §5.3.4).
  await waitForChildren(ctx, groupId, childRunIds);

  // ── 5. Consolidation: merge child branches ──────────────────────────
  // SAD §5.5.3: journaled merge with conflict handling.
  await updateRunStatus(ctx.runId, "running");

  const consolidationResult = await consolidate({
    parentRunId: ctx.runId,
    parallelGroupId: groupId,
  });

  if (consolidationResult.conflict) {
    await handleConsolidationConflict(ctx, groupId, consolidationResult);
  }

  // ── 6. Consolidation review (SAD §5.3.5) ────────────────────────────
  const consReview = await createReview({
    runId: ctx.runId,
    stageName: null as any, // consolidation reviews have NULL stageName
    round: 1,
    type: "consolidation",
    lastAssistantMessage: null,
    planMarkdown: null,
  });

  await updateRunStatus(ctx.runId, "awaiting_review");

  const consDecision = await reviewDecisionHook.create({
    token: `review:${consReview.id}`,
    data: {
      reviewId: consReview.id,
      runId: ctx.runId,
      stageName: null,
    },
  });

  if (consDecision.action !== "approve") {
    // SAD §5.3.5: request_changes not supported for consolidation reviews.
    // User should fix via child reruns. Cancellation path:
    await updateRunStatus(ctx.runId, "cancelled");
    await stopSession(ctx.runId);
    return;
  }

  // ── 7. Finalize if this was the last stage ──────────────────────────
  if (isFinal) {
    await handleFinalization(ctx);
  }
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
      (s) => s === "completed" || s === "failed" || s === "cancelled"
    );

    if (!allTerminal) {
      // Not all done yet. Sleep and re-check. The "use workflow" runtime
      // persists state at each sleep call, making this crash-safe.
      await sleep(5_000);
      continue;
    }

    const allCompleted = statuses.every((s) => s === "completed");

    if (allCompleted) {
      return; // Proceed directly to consolidation
    }

    // ── Mixed results: suspend for user decision ────────────────────
    await updateRunStatus(ctx.runId, "children_completed_with_failures");

    const decision = await parallelCompletionHook.create({
      token: `parallel:${ctx.runId}`,
      data: {
        runId: ctx.runId,
        groupId,
        childRunIds,
        statuses: await getChildStatusMap(childRunIds),
      },
    });

    switch (decision.action) {
      case "consolidate_completed":
        // Proceed — consolidate step will filter to completed children only
        return;

      case "retry": {
        // Restart failed children, loop back to wait
        for (const childId of decision.childRunIds ?? []) {
          await retryChildRun(childId);
        }
        continue;
      }

      case "cancel":
        await cancelAllChildren(childRunIds);
        await updateRunStatus(ctx.runId, "cancelled");
        throw new Error("Parallel group cancelled by user");
    }
  }
}

// --- Consolidation conflict sub-flow ------------------------------------- //

async function handleConsolidationConflict(
  ctx: PipelineContext,
  groupId: string,
  consolidationResult: { conflict: boolean; conflictChildId?: string },
): Promise<void> {
  await updateRunStatus(ctx.runId, "awaiting_conflict_resolution");

  const decision = await conflictResolutionHook.create({
    token: `conflict:${ctx.runId}`,
    data: {
      runId: ctx.runId,
      groupId,
      conflictChildId: consolidationResult.conflictChildId ?? null,
      operation: "consolidate",
    },
  });

  if (decision.action === "cancel") {
    await updateRunStatus(ctx.runId, "failed");
    throw new Error("Consolidation cancelled due to unresolved conflict");
  }

  // decision.action === 'retry': user resolved externally, re-run consolidation
  const retryResult = await consolidate({
    parentRunId: ctx.runId,
    parallelGroupId: groupId,
  });

  if (retryResult.conflict) {
    // Recursive
    await handleConsolidationConflict(ctx, groupId, retryResult);
  }
}

// --- Finalization sub-flow ----------------------------------------------- //

/**
 * Final git operations: commit → rebase → merge → cleanup (SAD §5.5.2).
 * Uses the durable gitOperations journal (SAD §5.5.3).
 */
async function handleFinalization(ctx: PipelineContext): Promise<void> {
  await updateRunStatus(ctx.runId, "finalizing");

  const result = await finalize({
    runId: ctx.runId,
    targetBranch: ctx.targetBranch,
  });

  if (result.conflict) {
    // SAD §5.3.6: suspend for user-driven conflict resolution
    await updateRunStatus(ctx.runId, "awaiting_conflict_resolution");

    const decision = await conflictResolutionHook.create({
      token: `conflict:${ctx.runId}`,
      data: {
        runId: ctx.runId,
        groupId: null,
        conflictChildId: null,
        operation: "finalize",
      },
    });

    if (decision.action === "cancel") {
      await updateRunStatus(ctx.runId, "failed");
      await stopSession(ctx.runId);
      return;
    }

    // Retry finalization — user resolved the conflict externally
    const retryResult = await finalize({
      runId: ctx.runId,
      targetBranch: ctx.targetBranch,
    });

    if (retryResult.conflict) {
      // Recursive resolution loop
      await handleFinalization(ctx);
      return;
    }
  }
}

// --- DB helpers (thin wrappers) ------------------------------------------ //

async function loadContext(runId: string): Promise<PipelineContext> {
  const run = await db.query.workflowRuns.findFirst({
    where: eq(workflowRuns.id, runId),
    with: { workflowTemplate: true, project: true },
  });
  if (!run) throw new Error(`Workflow run ${runId} not found`);

  const stages: WorkflowStage[] = JSON.parse(run.workflowTemplate.stages);

  return {
    runId,
    projectId: run.projectId,
    agentDefinitionId: run.agentDefinitionId,
    description: run.description ?? "",
    baseBranch: run.baseBranch ?? "main",
    targetBranch: run.targetBranch ?? run.baseBranch ?? "main",
    credentialSetId: run.credentialSetId,
    stages,
  };
}

async function updateRunStatus(runId: string, status: string): Promise<void> {
  await db
    .update(workflowRuns)
    .set({ status })
    .where(eq(workflowRuns.id, runId));
}

async function updateCurrentStage(runId: string, stageName: string): Promise<void> {
  await db
    .update(workflowRuns)
    .set({ currentStage: stageName })
    .where(eq(workflowRuns.id, runId));
}

async function getCurrentRound(runId: string, stageName: string): Promise<number> {
  const exec = await db.query.stageExecutions.findFirst({
    where: and(
      eq(stageExecutions.workflowRunId, runId),
      eq(stageExecutions.stageName, stageName)
    ),
    orderBy: (se, { desc }) => [desc(se.round)],
  });
  return exec?.round ?? 0;
}

async function markStageSkipped(runId: string, stageName: string): Promise<void> {
  const round = await getCurrentRound(runId, stageName);
  await db
    .update(stageExecutions)
    .set({ status: "skipped" })
    .where(
      and(
        eq(stageExecutions.workflowRunId, runId),
        eq(stageExecutions.stageName, stageName),
        eq(stageExecutions.round, round),
      )
    );
}

async function stopSession(runId: string): Promise<void> {
  const { sessionManager } = await import("../services/session-manager");
  await sessionManager.stop(runId);
}

async function getChildStatuses(childRunIds: string[]): Promise<string[]> {
  const runs = await db.query.workflowRuns.findMany({
    where: (wr, { inArray }) => inArray(wr.id, childRunIds),
    columns: { status: true },
  });
  return runs.map((r) => r.status);
}

async function getChildStatusMap(
  childRunIds: string[]
): Promise<Record<string, string>> {
  const runs = await db.query.workflowRuns.findMany({
    where: (wr, { inArray }) => inArray(wr.id, childRunIds),
    columns: { id: true, status: true },
  });
  return Object.fromEntries(runs.map((r) => [r.id, r.status]));
}

async function retryChildRun(childRunId: string): Promise<void> {
  // Reset the child run to pending, re-trigger its workflow pipeline.
  const { start } = await import("workflow/api");
  await db
    .update(workflowRuns)
    .set({ status: "pending" })
    .where(eq(workflowRuns.id, childRunId));
  await start(runWorkflowPipeline, [{ runId: childRunId }]);
}

async function cancelAllChildren(childRunIds: string[]): Promise<void> {
  for (const id of childRunIds) {
    const run = await db.query.workflowRuns.findFirst({
      where: eq(workflowRuns.id, id),
    });
    if (run?.status === "running") {
      await stopSession(id);
    }
    await db
      .update(workflowRuns)
      .set({ status: "cancelled" })
      .where(eq(workflowRuns.id, id));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

---

## 2. Hook Definitions (`workflows/hooks.ts`)

Each hook defines the payload shape sent to the GUI (via the `data` field) and the response shape the workflow expects when resumed. Hook tokens are unique strings that the route handler passes to `resumeHook()` (SAD §5.2).

```typescript
// workflows/hooks.ts
"use workflow";

import { defineHook } from "workflow/api";
import { z } from "zod";

// -------------------------------------------------------------------------- //
// 2.1  Review Decision Hook (SAD §5.3.1)
//
// Suspends after create-review. Resumed by:
//   POST /api/reviews/:id/approve   → { action: 'approve' }
//   POST /api/reviews/:id/submit    → { action: 'request_changes', comments }
// -------------------------------------------------------------------------- //

const reviewCommentSchema = z.object({
  id: z.string(),
  filePath: z.string().nullable(),
  lineNumber: z.number().nullable(),
  side: z.enum(["left", "right"]).nullable(),
  body: z.string(),
});

export type ReviewComment = z.infer<typeof reviewCommentSchema>;

export const reviewDecisionHook = defineHook({
  name: "review-decision",

  dataSchema: z.object({
    reviewId: z.string(),
    runId: z.string(),
    stageName: z.string().nullable(),
  }),

  responseSchema: z.discriminatedUnion("action", [
    z.object({
      action: z.literal("approve"),
    }),
    z.object({
      action: z.literal("request_changes"),
      comments: z.array(reviewCommentSchema).min(1),
    }),
  ]),
});

// -------------------------------------------------------------------------- //
// 2.2  Stage Failed Hook (SAD §5.3.2)
//
// Suspends when a stage execution fails. Resumed by:
//   POST /api/runs/:id/retry-stage  → { action: 'retry' }
//   POST /api/runs/:id/skip-stage   → { action: 'skip' }
//   POST /api/runs/:id/cancel       → { action: 'cancel' }
// -------------------------------------------------------------------------- //

export const stageFailedHook = defineHook({
  name: "stage-failed",

  dataSchema: z.object({
    runId: z.string(),
    stageName: z.string(),
    error: z.string(),
  }),

  responseSchema: z.discriminatedUnion("action", [
    z.object({ action: z.literal("retry") }),
    z.object({ action: z.literal("skip") }),
    z.object({ action: z.literal("cancel") }),
  ]),
});

// -------------------------------------------------------------------------- //
// 2.3  Proposal Review Hook (SAD §5.3.3)
//
// Suspends after split-stage proposal extraction. User reviews/edits
// proposals in GUI, then launches selected ones. Resumed by:
//   POST /api/proposals/launch → { proposalIds: [...] }
// -------------------------------------------------------------------------- //

export const proposalReviewHook = defineHook({
  name: "proposal-review",

  dataSchema: z.object({
    runId: z.string(),
    proposalIds: z.array(z.string()),
  }),

  responseSchema: z.object({
    proposalIds: z.array(z.string()).min(1),
  }),
});

// -------------------------------------------------------------------------- //
// 2.4  Parallel Completion Hook (SAD §5.3.4)
//
// Suspends when children reach terminal state but some failed/cancelled.
// If all children completed successfully, this hook is skipped (workflow
// proceeds directly to consolidation). Resumed by:
//   POST /api/parallel-groups/:groupId/consolidate-partial
//   POST /api/parallel-groups/:groupId/retry-children
//   POST /api/parallel-groups/:groupId/cancel
// -------------------------------------------------------------------------- //

export const parallelCompletionHook = defineHook({
  name: "parallel-completion",

  dataSchema: z.object({
    runId: z.string(),
    groupId: z.string(),
    childRunIds: z.array(z.string()),
    statuses: z.record(z.string(), z.string()),
  }),

  responseSchema: z.discriminatedUnion("action", [
    z.object({ action: z.literal("consolidate_completed") }),
    z.object({
      action: z.literal("retry"),
      childRunIds: z.array(z.string()).min(1),
    }),
    z.object({ action: z.literal("cancel") }),
  ]),
});

// -------------------------------------------------------------------------- //
// 2.5  Conflict Resolution Hook (SAD §5.3.6)
//
// Suspends when finalization rebase or consolidation merge hits a conflict.
// User resolves externally, then signals retry or cancel. Resumed by:
//   POST /api/runs/:id/resolve-conflict → { action: 'retry' }
//   POST /api/runs/:id/cancel           → { action: 'cancel' }
// -------------------------------------------------------------------------- //

export const conflictResolutionHook = defineHook({
  name: "conflict-resolution",

  dataSchema: z.object({
    runId: z.string(),
    groupId: z.string().nullable(),
    conflictChildId: z.string().nullable(),
    operation: z.enum(["finalize", "consolidate"]),
  }),

  responseSchema: z.discriminatedUnion("action", [
    z.object({ action: z.literal("retry") }),
    z.object({ action: z.literal("cancel") }),
  ]),
});
```

---

## 3. Workflow Steps (`workflows/steps/`)

Each `"use step"` function is replay-safe: it checks for an existing result before performing side effects. The `"use workflow"` runtime may re-execute steps during replay, so all DB writes are guarded by unique constraints (SAD §5.3, §4.1).

### 3.1 `execute-stage.ts`

Sends a prompt into the ACP session and awaits agent completion. Manages session mode (create / continue / fresh) based on stage configuration and round (SAD §5.3, §5.4).

```typescript
// workflows/steps/execute-stage.ts
"use step";

import { db } from "../../db";
import { stageExecutions, workflowRuns, runMessages } from "../../db/schema";
import { eq, and } from "drizzle-orm";
import { sessionManager } from "../../services/session-manager";
import { buildStagePrompt } from "../../services/prompt-builder";
import { streamingService } from "../../services/streaming-service";
import { logger } from "../../lib/logger";
import type { ReviewComment } from "../hooks";

interface ExecuteStageInput {
  runId: string;
  stage: {
    name: string;
    type: "standard" | "split";
    promptTemplate: string;
    freshSession: boolean;
  };
  stageIndex: number;
  round: number;
  isFirstStage: boolean;
  previousResult: { lastAssistantMessage: string | null; planMarkdown: string | null } | null;
  requestChangesComments: ReviewComment[] | null;
  retryError?: string;
}

interface ExecuteStageOutput {
  status: "completed" | "failed";
  lastAssistantMessage: string | null;
  planMarkdown: string | null;
  error?: string;
}

export async function executeStage(input: ExecuteStageInput): Promise<ExecuteStageOutput> {
  const { runId, stage, round } = input;
  const log = logger.child({ runId, stage: stage.name, round });

  // ── Step 1: Idempotency check (SAD §5.3, step 1) ───────────────────
  const existing = await db.query.stageExecutions.findFirst({
    where: and(
      eq(stageExecutions.workflowRunId, runId),
      eq(stageExecutions.stageName, stage.name),
      eq(stageExecutions.round, round),
    ),
  });

  if (existing?.status === "completed") {
    log.info("Stage already completed, returning cached result");
    return {
      status: "completed",
      lastAssistantMessage: await getLastAssistantMessage(runId, stage.name, round),
      planMarkdown: null,
    };
  }

  if (existing?.status === "failed") {
    return {
      status: "failed",
      lastAssistantMessage: null,
      planMarkdown: null,
      error: existing.failureReason ?? "Previous execution failed",
    };
  }

  // ── Step 2: Create stageExecution record ────────────────────────────
  const execId = existing?.id ?? crypto.randomUUID();

  if (!existing) {
    await db.insert(stageExecutions).values({
      id: execId,
      workflowRunId: runId,
      stageName: stage.name,
      round,
      status: "pending",
      freshSession: stage.freshSession ? 1 : 0,
    });
  }

  // ── Step 3: Determine session mode (SAD §5.4) ──────────────────────
  try {
    if (input.isFirstStage && round === 1) {
      // First stage of the entire workflow run: provision everything
      await sessionManager.create(runId);
    } else if (stage.freshSession && round === 1) {
      // Fresh session in the same sandbox/worktree (SAD §5.4, stage 3)
      const context = await buildFreshSessionContext(runId, input.previousResult);
      await sessionManager.fresh(runId, context);
    }
    // else: continuation — session already exists, just send prompt

    // ── Step 4: Build prompt (see §5 Prompt Builder) ────────────────
    const prompt = buildStagePrompt({
      runDescription: await getRunDescription(runId),
      stage,
      round,
      retryError: input.retryError ?? null,
      requestChangesComments: input.requestChangesComments,
      freshSessionContext: stage.freshSession
        ? await buildFreshSessionContext(runId, input.previousResult)
        : null,
    });

    // Store the built prompt on the stageExecution record
    await db
      .update(stageExecutions)
      .set({ prompt, status: "running", startedAt: new Date().toISOString() })
      .where(eq(stageExecutions.id, execId));

    // ── Step 5: Send prompt into ACP session ────────────────────────
    // sessionManager.continue() acquires the per-run mutex, writes to
    // stdin, and returns. The streaming service handles stdout events.
    if (input.isFirstStage && round === 1) {
      // create() already sent the initial prompt
      await sessionManager.sendPrompt(runId, prompt);
    } else {
      await sessionManager.continue(runId, prompt);
    }

    // ── Step 6: Record user prompt in runMessages ───────────────────
    await db.insert(runMessages).values({
      id: crypto.randomUUID(),
      workflowRunId: runId,
      stageName: stage.name,
      round,
      sessionBoundary: stage.freshSession && round === 1 ? 1 : 0,
      role: "user",
      content: prompt,
      isIntervention: 0,
      createdAt: new Date().toISOString(),
    });

    // ── Step 7: Stream output → WebSocket → GUI ─────────────────────
    // The streaming service is already consuming ACP stdout events and
    // forwarding them to WebSocket subscribers. We just await completion.

    // ── Step 8: Await agent completion ───────────────────────────────
    const result = await sessionManager.awaitCompletion(runId);

    // ── Step 9: Update stageExecution ───────────────────────────────
    await db
      .update(stageExecutions)
      .set({
        status: result.success ? "completed" : "failed",
        completedAt: new Date().toISOString(),
        failureReason: result.error ?? null,
        usageStats: result.usage ? JSON.stringify(result.usage) : null,
      })
      .where(eq(stageExecutions.id, execId));

    // ── Step 10: Capture plan.md from sandbox ───────────────────────
    let planMarkdown: string | null = null;
    try {
      planMarkdown = await sessionManager.readFile(runId, "plan.md");
    } catch {
      // plan.md is optional — not all agents create one
    }

    // ── Step 11: Get last assistant message ──────────────────────────
    const lastMsg = await getLastAssistantMessage(runId, stage.name, round);

    log.info({ status: result.success ? "completed" : "failed" }, "Stage finished");

    return {
      status: result.success ? "completed" : "failed",
      lastAssistantMessage: lastMsg,
      planMarkdown,
      error: result.error,
    };
  } catch (err: any) {
    log.error({ err }, "Stage execution error");

    await db
      .update(stageExecutions)
      .set({
        status: "failed",
        completedAt: new Date().toISOString(),
        failureReason: err.message ?? "Unknown error",
      })
      .where(eq(stageExecutions.id, execId));

    return {
      status: "failed",
      lastAssistantMessage: null,
      planMarkdown: null,
      error: err.message,
    };
  }
}

// --- Helpers ------------------------------------------------------------- //

async function getRunDescription(runId: string): Promise<string> {
  const run = await db.query.workflowRuns.findFirst({
    where: eq(workflowRuns.id, runId),
    columns: { description: true },
  });
  return run?.description ?? "";
}

async function getLastAssistantMessage(
  runId: string,
  stageName: string,
  round: number,
): Promise<string | null> {
  const msg = await db.query.runMessages.findFirst({
    where: and(
      eq(runMessages.workflowRunId, runId),
      eq(runMessages.stageName, stageName),
      eq(runMessages.round, round),
      eq(runMessages.role, "assistant"),
    ),
    orderBy: (m, { desc }) => [desc(m.createdAt)],
    columns: { content: true },
  });
  return msg?.content ?? null;
}

async function buildFreshSessionContext(
  runId: string,
  previousResult: { lastAssistantMessage: string | null; planMarkdown: string | null } | null,
): Promise<string> {
  // Collect context from all prior completed stages (SAD §5.4, FR-W8).
  const completedStages = await db.query.stageExecutions.findMany({
    where: and(
      eq(stageExecutions.workflowRunId, runId),
      eq(stageExecutions.status, "completed"),
    ),
    orderBy: (se, { asc }) => [asc(se.startedAt)],
  });

  const contextParts: string[] = [];

  for (const se of completedStages) {
    const lastMsg = await getLastAssistantMessage(runId, se.stageName, se.round);
    if (lastMsg) {
      contextParts.push(
        `## Stage "${se.stageName}" (round ${se.round}) — Agent's Final Response\n\n${lastMsg}`
      );
    }
  }

  if (previousResult?.planMarkdown) {
    contextParts.push(`## plan.md\n\n${previousResult.planMarkdown}`);
  }

  // Latest approved review summary
  const lastReview = await db.query.reviews.findFirst({
    where: and(
      eq(workflowRuns.id, runId), // joined via relation
    ),
    orderBy: (r, { desc }) => [desc(r.createdAt)],
    columns: { aiSummary: true },
  });

  if (lastReview?.aiSummary) {
    contextParts.push(`## Latest Approved Review Summary\n\n${lastReview.aiSummary}`);
  }

  return contextParts.join("\n\n---\n\n");
}
```

### 3.2 `create-review.ts`

Generates a diff snapshot, captures plan.md, requests an AI summary, and persists the review record (SAD §5.3.1, SRD FR-R1–R2).

```typescript
// workflows/steps/create-review.ts
"use step";

import { db } from "../../db";
import { reviews, workflowRuns } from "../../db/schema";
import { eq, and } from "drizzle-orm";
import { reviewService } from "../../services/review-service";
import { logger } from "../../lib/logger";

interface CreateReviewInput {
  runId: string;
  stageName: string | null;
  round: number;
  type: "stage" | "consolidation";
  lastAssistantMessage: string | null;
  planMarkdown: string | null;
}

interface CreateReviewOutput {
  id: string;
  diffSnapshot: string;
  aiSummary: string | null;
}

export async function createReview(input: CreateReviewInput): Promise<CreateReviewOutput> {
  const { runId, stageName, round, type } = input;
  const log = logger.child({ runId, stageName, round, type });

  // ── Idempotency: UNIQUE(workflowRunId, stageName, round, type) ────
  const existing = await db.query.reviews.findFirst({
    where: and(
      eq(reviews.workflowRunId, runId),
      stageName != null ? eq(reviews.stageName, stageName) : undefined,
      eq(reviews.round, round),
      eq(reviews.type, type),
    ),
  });

  if (existing) {
    log.info({ reviewId: existing.id }, "Review already exists, returning cached");
    return {
      id: existing.id,
      diffSnapshot: existing.diffSnapshot ?? "",
      aiSummary: existing.aiSummary,
    };
  }

  // ── Generate diff (merge-base to worktree HEAD) ───────────────────
  const run = await db.query.workflowRuns.findFirst({
    where: eq(workflowRuns.id, runId),
    columns: { worktreePath: true, baseBranch: true },
  });

  if (!run?.worktreePath) {
    throw new Error(`Workflow run ${runId} has no worktree path`);
  }

  const diffSnapshot = await reviewService.generateDiff(
    run.worktreePath,
    run.baseBranch ?? "main",
  );

  // ── AI summary ────────────────────────────────────────────────────
  const aiSummary = await reviewService.generateSummary(diffSnapshot);

  // ── Persist ───────────────────────────────────────────────────────
  const reviewId = crypto.randomUUID();

  await db.insert(reviews).values({
    id: reviewId,
    workflowRunId: runId,
    stageName,
    round,
    type,
    status: "pending_review",
    aiSummary,
    diffSnapshot,
    planMarkdown: input.planMarkdown,
    createdAt: new Date().toISOString(),
  });

  log.info({ reviewId }, "Review created");

  return { id: reviewId, diffSnapshot, aiSummary };
}
```

### 3.3 `inject-comments.ts`

Bundles review comments into a markdown user message and sends it into the existing ACP session (SAD §5.3.1, SRD FR-R7).

```typescript
// workflows/steps/inject-comments.ts
"use step";

import { db } from "../../db";
import { runMessages, stageExecutions, reviews } from "../../db/schema";
import { eq } from "drizzle-orm";
import { sessionManager } from "../../services/session-manager";
import { logger } from "../../lib/logger";
import type { ReviewComment } from "../hooks";

interface InjectCommentsInput {
  runId: string;
  reviewId: string;
  comments: ReviewComment[];
}

export async function injectComments(input: InjectCommentsInput): Promise<void> {
  const { runId, reviewId, comments } = input;
  const log = logger.child({ runId, reviewId });

  if (comments.length === 0) {
    log.warn("No comments to inject");
    return;
  }

  // ── Build markdown message ────────────────────────────────────────
  const message = formatCommentsAsMarkdown(comments);

  // ── Send into the ACP session (same conversation) ─────────────────
  // sessionManager.continue() serializes stdin writes via the per-run mutex
  // (SAD §5.4, session command serialization).
  await sessionManager.continue(runId, message);

  // ── Record in runMessages (append-only, FR-W19) ───────────────────
  const review = await db.query.reviews.findFirst({
    where: eq(reviews.id, reviewId),
    columns: { stageName: true, round: true },
  });

  await db.insert(runMessages).values({
    id: crypto.randomUUID(),
    workflowRunId: runId,
    stageName: review?.stageName ?? "unknown",
    round: review?.round ?? 1,
    sessionBoundary: 0,
    role: "user",
    content: message,
    isIntervention: 0,
    metadata: JSON.stringify({ type: "review_comments", reviewId }),
    createdAt: new Date().toISOString(),
  });

  log.info({ commentCount: comments.length }, "Review comments injected");
}

// --- Formatting ---------------------------------------------------------- //

function formatCommentsAsMarkdown(comments: ReviewComment[]): string {
  const parts: string[] = [
    "# Review Feedback — Changes Requested\n",
    "Please address the following review comments:\n",
  ];

  const generalComments = comments.filter((c) => !c.filePath);
  const fileComments = comments.filter((c) => c.filePath);

  if (generalComments.length > 0) {
    parts.push("## General Comments\n");
    for (const c of generalComments) {
      parts.push(`- ${c.body}\n`);
    }
  }

  if (fileComments.length > 0) {
    // Group by file
    const byFile = new Map<string, ReviewComment[]>();
    for (const c of fileComments) {
      const existing = byFile.get(c.filePath!) ?? [];
      existing.push(c);
      byFile.set(c.filePath!, existing);
    }

    parts.push("## File-Specific Comments\n");
    for (const [filePath, fileComms] of byFile) {
      parts.push(`### \`${filePath}\`\n`);
      for (const c of fileComms) {
        const lineRef = c.lineNumber ? ` (line ${c.lineNumber})` : "";
        parts.push(`- ${lineRef}${lineRef ? " " : ""}${c.body}\n`);
      }
    }
  }

  parts.push(
    "\nPlease make the requested changes and let me know when you're done."
  );

  return parts.join("\n");
}
```

### 3.4 `extract-proposals.ts`

Parses the split-stage agent output for proposals and persists them (SAD §5.3.3, SRD FR-S1–S2).

```typescript
// workflows/steps/extract-proposals.ts
"use step";

import { db } from "../../db";
import { proposals } from "../../db/schema";
import { eq, and } from "drizzle-orm";
import { proposalService } from "../../services/proposal-service";
import { logger } from "../../lib/logger";

interface ExtractProposalsInput {
  runId: string;
  stageName: string;
  agentOutput: string;
}

interface ProposalRecord {
  id: string;
  title: string;
  description: string;
  affectedFiles: string[];
  dependsOn: string[];
  sortOrder: number;
}

export async function extractProposals(
  input: ExtractProposalsInput
): Promise<ProposalRecord[]> {
  const { runId, stageName, agentOutput } = input;
  const log = logger.child({ runId, stageName });

  // ── Idempotency: check if proposals already exist for this stage ──
  const existing = await db.query.proposals.findMany({
    where: and(
      eq(proposals.workflowRunId, runId),
      eq(proposals.stageName, stageName),
    ),
  });

  if (existing.length > 0) {
    log.info({ count: existing.length }, "Proposals already extracted, returning cached");
    return existing.map(mapToRecord);
  }

  // ── Parse agent output ────────────────────────────────────────────
  // The proposalService uses a structured extraction approach:
  // 1. Try parsing JSON blocks (```json ... ```) from agent output
  // 2. Fallback: use LLM to extract proposals from freeform text
  const parsed = await proposalService.parseProposals(agentOutput);

  // ── Persist each proposal ─────────────────────────────────────────
  const records: ProposalRecord[] = [];

  for (let i = 0; i < parsed.length; i++) {
    const p = parsed[i];
    const id = crypto.randomUUID();

    await db.insert(proposals).values({
      id,
      workflowRunId: runId,
      stageName,
      title: p.title,
      description: p.description,
      affectedFiles: JSON.stringify(p.affectedFiles ?? []),
      dependsOn: JSON.stringify(p.dependsOn ?? []),
      sortOrder: i,
      status: "proposed",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    records.push({
      id,
      title: p.title,
      description: p.description,
      affectedFiles: p.affectedFiles ?? [],
      dependsOn: p.dependsOn ?? [],
      sortOrder: i,
    });
  }

  log.info({ count: records.length }, "Proposals extracted and persisted");
  return records;
}

function mapToRecord(row: any): ProposalRecord {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    affectedFiles: JSON.parse(row.affectedFiles ?? "[]"),
    dependsOn: JSON.parse(row.dependsOn ?? "[]"),
    sortOrder: row.sortOrder,
  };
}
```

### 3.5 `launch-children.ts`

Creates a parallel group and launches independent child workflow runs, each with its own sandbox + worktree branched off the parent's worktree HEAD (SAD §5.5.2, SRD FR-S4–S6).

```typescript
// workflows/steps/launch-children.ts
"use step";

import { db } from "../../db";
import {
  parallelGroups,
  proposals,
  workflowRuns,
  workflowTemplates,
} from "../../db/schema";
import { eq, inArray } from "drizzle-orm";
import { start } from "workflow/api";
import { runWorkflowPipeline } from "../pipeline";
import { worktreeService } from "../../services/worktree";
import { branchNamer } from "../../services/branch-namer";
import { logger } from "../../lib/logger";

interface LaunchChildrenInput {
  parentRunId: string;
  selectedProposalIds: string[];
  projectId: string;
  agentDefinitionId: string;
  credentialSetId: string | null;
}

interface LaunchChildrenOutput {
  groupId: string;
  childRunIds: string[];
}

export async function launchChildren(
  input: LaunchChildrenInput
): Promise<LaunchChildrenOutput> {
  const { parentRunId, selectedProposalIds, projectId, agentDefinitionId, credentialSetId } = input;
  const log = logger.child({ parentRunId });

  // ── Idempotency: check if parallel group already exists ───────────
  const existingGroup = await db.query.parallelGroups.findFirst({
    where: eq(parallelGroups.sourceWorkflowRunId, parentRunId),
  });

  if (existingGroup) {
    // Group already created — find child run IDs
    const children = await db.query.workflowRuns.findMany({
      where: eq(workflowRuns.parallelGroupId, existingGroup.id),
      columns: { id: true },
    });
    log.info({ groupId: existingGroup.id }, "Parallel group already exists");
    return {
      groupId: existingGroup.id,
      childRunIds: children.map((c) => c.id),
    };
  }

  // ── Snapshot parent worktree state (SAD §5.5.2) ───────────────────
  const parentRun = await db.query.workflowRuns.findFirst({
    where: eq(workflowRuns.id, parentRunId),
    columns: { worktreePath: true, branch: true },
    with: { project: { columns: { localPath: true } } },
  });

  if (!parentRun?.worktreePath) {
    throw new Error(`Parent run ${parentRunId} has no worktree`);
  }

  await worktreeService.commitAll(parentRun.worktreePath, "Snapshot before split");

  // ── Create parallel group ─────────────────────────────────────────
  const groupId = crypto.randomUUID();
  await db.insert(parallelGroups).values({
    id: groupId,
    sourceWorkflowRunId: parentRunId,
    status: "running",
    createdAt: new Date().toISOString(),
  });

  // ── Load selected proposals ───────────────────────────────────────
  const selectedProposals = await db.query.proposals.findMany({
    where: inArray(proposals.id, selectedProposalIds),
    orderBy: (p, { asc }) => [asc(p.sortOrder)],
  });

  // ── Resolve default template for children ─────────────────────────
  const defaultTemplate = await db.query.workflowTemplates.findFirst({
    where: eq(workflowTemplates.name, "Quick Run"),
    columns: { id: true },
  });

  // ── Launch each child ─────────────────────────────────────────────
  const childRunIds: string[] = [];

  for (const proposal of selectedProposals) {
    const templateId = proposal.workflowTemplateOverride ?? defaultTemplate?.id;
    if (!templateId) {
      throw new Error("No workflow template available for child run");
    }

    // Generate branch name from proposal title (SAD §5.5.2)
    const childBranch = await branchNamer.generate(
      proposal.title,
      `vibe-harness/split-${proposal.id.slice(0, 8)}`,
    );

    // Create child worktree branched off parent's worktree HEAD
    const childWorktreePath = await worktreeService.createFromWorktree(
      parentRun.project.localPath,
      parentRun.worktreePath,
      childBranch,
    );

    // Create child workflow run record
    const childRunId = crypto.randomUUID();

    await db.insert(workflowRuns).values({
      id: childRunId,
      workflowTemplateId: templateId,
      projectId,
      agentDefinitionId,
      parentRunId,
      parallelGroupId: groupId,
      description: proposal.description,
      title: proposal.title,
      status: "pending",
      branch: childBranch,
      worktreePath: childWorktreePath,
      credentialSetId,
      baseBranch: parentRun.branch,
      targetBranch: parentRun.branch, // merge back into parent branch
      createdAt: new Date().toISOString(),
    });

    // Update proposal status
    await db
      .update(proposals)
      .set({
        status: "launched",
        launchedWorkflowRunId: childRunId,
        parallelGroupId: groupId,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(proposals.id, proposal.id));

    childRunIds.push(childRunId);

    // Fire-and-forget: start child pipeline (SAD §5.2)
    await start(runWorkflowPipeline, [{ runId: childRunId }]);

    log.info({ childRunId, proposal: proposal.title }, "Child workflow launched");
  }

  return { groupId, childRunIds };
}
```

### 3.6 `consolidate.ts`

Merges completed child branches into a consolidation branch using the durable git operations journal (SAD §5.5.3, SRD FR-S8–S10).

```typescript
// workflows/steps/consolidate.ts
"use step";

import { db } from "../../db";
import { gitOperations, workflowRuns, proposals, parallelGroups } from "../../db/schema";
import { eq, and } from "drizzle-orm";
import { worktreeService } from "../../services/worktree";
import { logger } from "../../lib/logger";

interface ConsolidateInput {
  parentRunId: string;
  parallelGroupId: string;
}

interface ConsolidateOutput {
  conflict: boolean;
  conflictChildId?: string;
}

export async function consolidate(input: ConsolidateInput): Promise<ConsolidateOutput> {
  const { parentRunId, parallelGroupId } = input;
  const log = logger.child({ parentRunId, parallelGroupId });

  // ── Load or resume journal (SAD §5.5.3) ───────────────────────────
  let journal = await db.query.gitOperations.findFirst({
    where: and(
      eq(gitOperations.workflowRunId, parentRunId),
      eq(gitOperations.type, "consolidate"),
    ),
  });

  if (journal?.phase === "done") {
    log.info("Consolidation already completed");
    return { conflict: false };
  }

  const parentRun = await db.query.workflowRuns.findFirst({
    where: eq(workflowRuns.id, parentRunId),
    columns: { worktreePath: true, branch: true },
    with: { project: { columns: { localPath: true } } },
  });

  if (!parentRun?.worktreePath) {
    throw new Error(`Parent run ${parentRunId} has no worktree`);
  }

  // Get completed children in sort order (SRD FR-S9)
  const completedChildren = await db.query.workflowRuns.findMany({
    where: and(
      eq(workflowRuns.parallelGroupId, parallelGroupId),
      eq(workflowRuns.status, "completed"),
    ),
    orderBy: (wr, { asc }) => [asc(wr.createdAt)], // fallback order; proposals.sortOrder preferred
  });

  // Resolve merge order from proposals.sortOrder
  const childRunIds = await resolveChildMergeOrder(parallelGroupId, completedChildren);

  // Initialize metadata if no journal exists
  const metadata = journal
    ? JSON.parse(journal.metadata ?? "{}")
    : {
        consolidationBranch: `vibe-harness/consolidate-${parentRunId.slice(0, 8)}`,
        mergeOrder: childRunIds,
        mergedChildren: [],
        conflictChild: null,
      };

  // Create journal entry if new
  if (!journal) {
    const journalId = crypto.randomUUID();
    await db.insert(gitOperations).values({
      id: journalId,
      type: "consolidate",
      workflowRunId: parentRunId,
      parallelGroupId,
      phase: "snapshot_parent",
      metadata: JSON.stringify(metadata),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    journal = { id: journalId, phase: "snapshot_parent", metadata: JSON.stringify(metadata) } as any;
  }

  const projectPath = parentRun.project.localPath;

  // ── Phase: snapshot_parent ────────────────────────────────────────
  if (journal!.phase === "snapshot_parent") {
    await worktreeService.withRepoLock(projectPath, async () => {
      await worktreeService.commitAllIfDirty(
        parentRun.worktreePath!,
        "Snapshot before consolidation",
      );
      // Create consolidation branch from parent HEAD
      await worktreeService.createBranch(
        parentRun.worktreePath!,
        metadata.consolidationBranch,
      );
    });

    await advanceJournalPhase(journal!.id, "merge_children", metadata);
  }

  // ── Phase: merge_children (SAD §5.5.3) ────────────────────────────
  if (journal!.phase === "merge_children" || journal?.phase === "snapshot_parent") {
    for (const childRunId of metadata.mergeOrder) {
      if (metadata.mergedChildren.includes(childRunId)) {
        continue; // Already merged in a prior attempt
      }

      const childRun = await db.query.workflowRuns.findFirst({
        where: eq(workflowRuns.id, childRunId),
        columns: { branch: true },
      });

      if (!childRun?.branch) continue;

      const mergeResult = await worktreeService.withRepoLock(projectPath, async () => {
        return worktreeService.mergeNoFf(
          parentRun.worktreePath!,
          metadata.consolidationBranch,
          childRun.branch!,
        );
      });

      if (mergeResult.conflict) {
        log.warn({ childRunId, branch: childRun.branch }, "Merge conflict");
        metadata.conflictChild = childRunId;
        await advanceJournalPhase(journal!.id, "merge_children", metadata);

        // Abort the failed merge
        await worktreeService.withRepoLock(projectPath, async () => {
          await worktreeService.abortMerge(parentRun.worktreePath!);
        });

        return { conflict: true, conflictChildId: childRunId };
      }

      metadata.mergedChildren.push(childRunId);
      await advanceJournalPhase(journal!.id, "merge_children", metadata);
    }

    await advanceJournalPhase(journal!.id, "ff_parent", metadata);
  }

  // ── Phase: ff_parent ──────────────────────────────────────────────
  if (journal!.phase === "ff_parent") {
    await worktreeService.withRepoLock(projectPath, async () => {
      await worktreeService.fastForward(
        parentRun.worktreePath!,
        parentRun.branch!,
        metadata.consolidationBranch,
      );
    });

    await advanceJournalPhase(journal!.id, "cleanup", metadata);
  }

  // ── Phase: cleanup ────────────────────────────────────────────────
  if (journal!.phase === "cleanup") {
    for (const childRunId of metadata.mergedChildren) {
      const childRun = await db.query.workflowRuns.findFirst({
        where: eq(workflowRuns.id, childRunId),
        columns: { worktreePath: true, branch: true },
      });
      if (childRun?.worktreePath) {
        await worktreeService.withRepoLock(projectPath, async () => {
          await worktreeService.remove(childRun.worktreePath!);
          await worktreeService.deleteBranch(projectPath, childRun.branch!);
        });
      }
    }

    // Clean up consolidation branch
    await worktreeService.withRepoLock(projectPath, async () => {
      await worktreeService.deleteBranch(projectPath, metadata.consolidationBranch);
    });

    await advanceJournalPhase(journal!.id, "done", metadata);

    // Update parallel group status
    await db
      .update(parallelGroups)
      .set({ status: "completed", completedAt: new Date().toISOString() })
      .where(eq(parallelGroups.id, parallelGroupId));
  }

  log.info("Consolidation completed");
  return { conflict: false };
}

// --- Helpers ------------------------------------------------------------- //

async function advanceJournalPhase(
  journalId: string,
  phase: string,
  metadata: any,
): Promise<void> {
  await db
    .update(gitOperations)
    .set({
      phase,
      metadata: JSON.stringify(metadata),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(gitOperations.id, journalId));
}

async function resolveChildMergeOrder(
  parallelGroupId: string,
  completedChildren: { id: string }[],
): Promise<string[]> {
  // Resolve order from proposals.sortOrder for deterministic merging
  const proposalRecords = await db.query.proposals.findMany({
    where: eq(proposals.parallelGroupId, parallelGroupId),
    orderBy: (p, { asc }) => [asc(p.sortOrder)],
    columns: { launchedWorkflowRunId: true },
  });

  const completedIds = new Set(completedChildren.map((c) => c.id));
  return proposalRecords
    .map((p) => p.launchedWorkflowRunId)
    .filter((id): id is string => id != null && completedIds.has(id));
}
```

### 3.7 `finalize.ts`

Performs the final git operations: commit → rebase → merge → cleanup. Uses the durable journal for crash recovery (SAD §5.5.2, §5.5.3, SRD FR-R10).

```typescript
// workflows/steps/finalize.ts
"use step";

import { db } from "../../db";
import { gitOperations, workflowRuns } from "../../db/schema";
import { eq, and } from "drizzle-orm";
import { worktreeService } from "../../services/worktree";
import { sessionManager } from "../../services/session-manager";
import { logger } from "../../lib/logger";

interface FinalizeInput {
  runId: string;
  targetBranch: string;
}

interface FinalizeOutput {
  conflict: boolean;
}

export async function finalize(input: FinalizeInput): Promise<FinalizeOutput> {
  const { runId, targetBranch } = input;
  const log = logger.child({ runId, targetBranch });

  // ── Load or resume journal (SAD §5.5.3) ───────────────────────────
  let journal = await db.query.gitOperations.findFirst({
    where: and(
      eq(gitOperations.workflowRunId, runId),
      eq(gitOperations.type, "finalize"),
    ),
  });

  if (journal?.phase === "done") {
    log.info("Finalization already completed");
    return { conflict: false };
  }

  const run = await db.query.workflowRuns.findFirst({
    where: eq(workflowRuns.id, runId),
    columns: { worktreePath: true, branch: true, sandboxId: true },
    with: { project: { columns: { localPath: true } } },
  });

  if (!run?.worktreePath || !run?.branch) {
    throw new Error(`Run ${runId} missing worktree or branch`);
  }

  const projectPath = run.project.localPath;
  const metadata = journal
    ? JSON.parse(journal.metadata ?? "{}")
    : { targetBranch };

  // Create journal entry if new
  if (!journal) {
    const journalId = crypto.randomUUID();
    await db.insert(gitOperations).values({
      id: journalId,
      type: "finalize",
      workflowRunId: runId,
      phase: "commit",
      metadata: JSON.stringify(metadata),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    journal = { id: journalId, phase: "commit" } as any;
  }

  // ── Phase: commit ─────────────────────────────────────────────────
  if (journal!.phase === "commit") {
    await worktreeService.withRepoLock(projectPath, async () => {
      await worktreeService.commitAllIfDirty(
        run.worktreePath!,
        "Final commit from Vibe Harness workflow",
      );
    });
    await advancePhase(journal!.id, "rebase", metadata);
  }

  // ── Phase: rebase ─────────────────────────────────────────────────
  if (journal!.phase === "rebase") {
    const rebaseResult = await worktreeService.withRepoLock(projectPath, async () => {
      return worktreeService.rebase(run.worktreePath!, targetBranch);
    });

    if (rebaseResult.conflict) {
      log.warn("Rebase conflict detected");

      // Abort the rebase so the worktree is in a clean state for user
      await worktreeService.withRepoLock(projectPath, async () => {
        await worktreeService.abortRebase(run.worktreePath!);
      });

      return { conflict: true };
    }

    await advancePhase(journal!.id, "merge", metadata);
  }

  // ── Phase: merge (fast-forward into target) ───────────────────────
  if (journal!.phase === "merge") {
    await worktreeService.withRepoLock(projectPath, async () => {
      await worktreeService.fastForwardMerge(
        projectPath,
        targetBranch,
        run.branch!,
      );
    });
    await advancePhase(journal!.id, "cleanup", metadata);
  }

  // ── Phase: cleanup ────────────────────────────────────────────────
  if (journal!.phase === "cleanup") {
    // Stop the ACP session and sandbox
    try {
      await sessionManager.stop(runId);
    } catch {
      // Best-effort — sandbox may already be gone
    }

    // Remove worktree and branch
    await worktreeService.withRepoLock(projectPath, async () => {
      await worktreeService.remove(run.worktreePath!);
      await worktreeService.deleteBranch(projectPath, run.branch!);
    });

    // Clear run references
    await db
      .update(workflowRuns)
      .set({
        sandboxId: null,
        worktreePath: null,
        completedAt: new Date().toISOString(),
      })
      .where(eq(workflowRuns.id, runId));

    await advancePhase(journal!.id, "done", metadata);
  }

  log.info("Finalization completed");
  return { conflict: false };
}

async function advancePhase(
  journalId: string,
  phase: string,
  metadata: any,
): Promise<void> {
  await db
    .update(gitOperations)
    .set({
      phase,
      metadata: JSON.stringify(metadata),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(gitOperations.id, journalId));
}
```

---

## 4. Session Manager (`services/session-manager.ts`)

Owns the ACP session lifecycle across stages within a workflow run. One sandbox, one worktree, and (by default) one continuous conversation. All stdin writes are serialized through a per-run mutex to prevent races between stage transitions, user interventions, and cancellation (SAD §5.4).

```typescript
// services/session-manager.ts

import { Mutex } from "async-mutex";
import { db } from "../db";
import { workflowRuns, runMessages } from "../db/schema";
import { eq } from "drizzle-orm";
import { sandboxService } from "./sandbox";
import { worktreeService } from "./worktree";
import { acpClient, type AcpSession, type CompletionResult } from "./acp-client";
import { credentialVault } from "./credential-vault";
import { branchNamer } from "./branch-namer";
import { streamingService } from "./streaming-service";
import { logger } from "../lib/logger";

/** Active session state per workflow run. Stored in-memory only. */
interface ActiveSession {
  runId: string;
  sandboxId: string;
  worktreePath: string;
  acpSession: AcpSession;
  mutex: Mutex;
}

class SessionManager {
  /** runId → ActiveSession. In-memory map, lost on daemon restart. */
  private sessions = new Map<string, ActiveSession>();

  /**
   * Acquire the per-run mutex for stdin serialization (SAD §5.4).
   * All operations that write to ACP stdin go through this.
   */
  private async withSession<T>(runId: string, fn: (session: ActiveSession) => Promise<T>): Promise<T> {
    const session = this.sessions.get(runId);
    if (!session) {
      throw new Error(`No active session for run ${runId}`);
    }
    return session.mutex.runExclusive(() => fn(session));
  }

  // -------------------------------------------------------------------
  // 4.1  create(runId) — Provision sandbox + worktree + ACP session
  //      Called for the first stage of a workflow run (SAD §5.4, Stage 1).
  // -------------------------------------------------------------------

  async create(runId: string): Promise<void> {
    const log = logger.child({ runId, op: "session.create" });

    if (this.sessions.has(runId)) {
      log.info("Session already exists, skipping creation (idempotent)");
      return;
    }

    const run = await db.query.workflowRuns.findFirst({
      where: eq(workflowRuns.id, runId),
      with: {
        project: { columns: { localPath: true } },
        agentDefinition: true,
      },
    });

    if (!run) throw new Error(`Run ${runId} not found`);

    const projectPath = run.project.localPath;

    // ── 1a. Generate branch name (SAD §5.5.2) ───────────────────────
    const branch = run.branch ?? await branchNamer.generate(
      run.description ?? "workflow run",
      `vibe-harness/run-${runId.slice(0, 8)}`,
    );

    // ── 1b. Create git worktree ─────────────────────────────────────
    const worktreePath = await worktreeService.withRepoLock(projectPath, async () => {
      return worktreeService.create(
        projectPath,
        branch,
        run.baseBranch ?? "main",
      );
    });

    // ── 1c. Provision Docker sandbox ────────────────────────────────
    const sandboxId = `vibe-${runId.slice(0, 8)}`;
    await sandboxService.create({
      name: sandboxId,
      image: run.agentDefinition.dockerImage ?? "vibe-harness/copilot:latest",
      worktreePath,
    });

    // ── 1d. Inject credentials ──────────────────────────────────────
    const credentialSetId =
      run.credentialSetId ?? run.project?.defaultCredentialSetId ?? null;

    if (credentialSetId) {
      await credentialVault.injectIntoSandbox(sandboxId, credentialSetId);
    }

    // ── 1e. Start ACP session ───────────────────────────────────────
    const acpSession = await acpClient.startSession({
      sandboxId,
      command: run.agentDefinition.commandTemplate,
      flags: ["--acp", "--stdio", "--yolo", "--autopilot"],
      worktreePath,
    });

    // Wire up streaming: ACP stdout → StreamingService → WebSocket
    acpSession.on("event", (event) => {
      streamingService.push(runId, event);
    });

    // ── 1f. Persist state ───────────────────────────────────────────
    await db
      .update(workflowRuns)
      .set({
        sandboxId,
        worktreePath,
        branch,
        acpSessionId: acpSession.sessionId,
      })
      .where(eq(workflowRuns.id, runId));

    this.sessions.set(runId, {
      runId,
      sandboxId,
      worktreePath,
      acpSession,
      mutex: new Mutex(),
    });

    log.info({ sandboxId, branch, worktreePath }, "Session created");
  }

  // -------------------------------------------------------------------
  // 4.2  continue(runId, prompt) — Send prompt into existing session
  //      Same sandbox, same ACP session (--continue semantics).
  //      SAD §5.4, Stage 2.
  // -------------------------------------------------------------------

  async continue(runId: string, prompt: string): Promise<void> {
    await this.withSession(runId, async (session) => {
      await session.acpSession.sendUserMessage(prompt);
    });
  }

  // Alias for continue — used by execute-stage when it holds the prompt separately.
  async sendPrompt(runId: string, prompt: string): Promise<void> {
    return this.continue(runId, prompt);
  }

  // -------------------------------------------------------------------
  // 4.3  fresh(runId, context) — Reset ACP session, inject context
  //      Same sandbox + worktree, new ACP session. Prior messages
  //      retained in runMessages with a sessionBoundary marker.
  //      SAD §5.4, Stage 3.
  // -------------------------------------------------------------------

  async fresh(runId: string, context: string): Promise<void> {
    await this.withSession(runId, async (session) => {
      const log = logger.child({ runId, op: "session.fresh" });

      // Stop current ACP session
      await session.acpSession.stop();

      // Start new ACP session in the same sandbox
      const run = await db.query.workflowRuns.findFirst({
        where: eq(workflowRuns.id, runId),
        with: { agentDefinition: true },
      });

      const newAcpSession = await acpClient.startSession({
        sandboxId: session.sandboxId,
        command: run!.agentDefinition.commandTemplate,
        flags: ["--acp", "--stdio", "--yolo", "--autopilot"],
        worktreePath: session.worktreePath,
      });

      // Re-wire streaming
      newAcpSession.on("event", (event) => {
        streamingService.push(runId, event);
      });

      // Update the active session reference
      session.acpSession = newAcpSession;

      // Persist new session ID
      await db
        .update(workflowRuns)
        .set({ acpSessionId: newAcpSession.sessionId })
        .where(eq(workflowRuns.id, runId));

      // Insert session boundary marker (FR-W19)
      await db.insert(runMessages).values({
        id: crypto.randomUUID(),
        workflowRunId: runId,
        stageName: "system",
        round: 1,
        sessionBoundary: 1,
        role: "system",
        content: "--- Session Reset ---",
        isIntervention: 0,
        metadata: JSON.stringify({ freshSessionContext: context.slice(0, 500) }),
        createdAt: new Date().toISOString(),
      });

      log.info("Fresh ACP session started");
    });
  }

  // -------------------------------------------------------------------
  // 4.4  stop(runId) — Graceful ACP stop + timeout + force-kill
  //      SAD §5.4, Cancellation. FR-W10.
  // -------------------------------------------------------------------

  async stop(runId: string): Promise<void> {
    const session = this.sessions.get(runId);
    if (!session) return; // Already stopped or never started

    const log = logger.child({ runId, op: "session.stop" });

    try {
      // Acquire mutex to ensure no concurrent stdin writes
      await session.mutex.runExclusive(async () => {
        // Send graceful ACP stop
        try {
          await session.acpSession.stop();
        } catch {
          log.warn("ACP stop command failed, proceeding to timeout");
        }

        // Wait up to 30s for agent to finish (FR-W10)
        const stopped = await session.acpSession.waitForExit(30_000);

        if (!stopped) {
          log.warn("Agent did not exit within 30s, force-killing sandbox");
          await sandboxService.forceStop(session.sandboxId);
        }
      });
    } finally {
      // Stop sandbox (best-effort)
      try {
        await sandboxService.stop(session.sandboxId);
      } catch {
        // Already stopped
      }

      // Clean up in-memory state
      this.sessions.delete(runId);
      log.info("Session stopped");
    }
  }

  // -------------------------------------------------------------------
  // 4.5  sendIntervention(runId, message) — Inject user message
  //      FR-W21: user can send mid-execution messages at any point.
  // -------------------------------------------------------------------

  async sendIntervention(runId: string, message: string): Promise<void> {
    await this.withSession(runId, async (session) => {
      await session.acpSession.sendUserMessage(message);

      // Record as intervention in runMessages (FR-W19)
      const run = await db.query.workflowRuns.findFirst({
        where: eq(workflowRuns.id, runId),
        columns: { currentStage: true },
      });

      await db.insert(runMessages).values({
        id: crypto.randomUUID(),
        workflowRunId: runId,
        stageName: run?.currentStage ?? "unknown",
        round: 1,
        sessionBoundary: 0,
        role: "user",
        content: message,
        isIntervention: 1,
        createdAt: new Date().toISOString(),
      });
    });
  }

  // -------------------------------------------------------------------
  // 4.6  awaitCompletion(runId) — Wait for agent to signal done
  //      Returns when ACP 'result' event received or agent exits.
  // -------------------------------------------------------------------

  async awaitCompletion(runId: string): Promise<CompletionResult> {
    const session = this.sessions.get(runId);
    if (!session) {
      throw new Error(`No active session for run ${runId}`);
    }

    // This does NOT acquire the mutex — we want interventions to be
    // injectable while we're waiting for completion.
    return session.acpSession.awaitResult();
  }

  // -------------------------------------------------------------------
  // 4.7  readFile(runId, path) — Read file from sandbox filesystem
  //      Used to capture plan.md from the agent's workspace.
  // -------------------------------------------------------------------

  async readFile(runId: string, relativePath: string): Promise<string> {
    const session = this.sessions.get(runId);
    if (!session) {
      throw new Error(`No active session for run ${runId}`);
    }

    return sandboxService.readFile(session.sandboxId, relativePath);
  }

  // -------------------------------------------------------------------
  // 4.8  Startup recovery — Mark orphaned sessions as lost
  //      Called by reconcile.ts on daemon startup (SAD §2.1.3).
  // -------------------------------------------------------------------

  async reconcile(): Promise<void> {
    // In-memory sessions map is empty after restart — that's correct.
    // Startup reconciler marks running stages as failed ('daemon_restart').
    // This method is a no-op; the reconciler handles DB state directly.
    this.sessions.clear();
  }
}

export const sessionManager = new SessionManager();
```

---

## 5. Prompt Builder

Constructs prompts for the various scenarios encountered during workflow execution (SAD §5.3 step 4, §5.4, SRD FR-W8).

```typescript
// services/prompt-builder.ts

import type { ReviewComment } from "../workflows/hooks";

interface StagePromptInput {
  runDescription: string;
  stage: {
    name: string;
    type: "standard" | "split";
    promptTemplate: string;
    freshSession: boolean;
  };
  round: number;
  retryError: string | null;
  requestChangesComments: ReviewComment[] | null;
  freshSessionContext: string | null;
}

/**
 * Build the prompt sent to the agent for a given stage + round.
 *
 * Structure follows SAD §5.3 step 4 and SRD FR-W8:
 * - Run description + stage template instructions
 * - For freshSession: prior-stage context (final messages, plan.md, review summary)
 * - For request_changes: bundled review comments
 * - For retry: failure-aware message (FR-W14)
 * - For split children: proposal description
 */
export function buildStagePrompt(input: StagePromptInput): string {
  const { runDescription, stage, round, retryError, requestChangesComments, freshSessionContext } = input;

  // ── 5.1  Standard stage continuation (round 1, no freshSession) ───
  // The simplest case: run description + stage instructions.
  // Agent continues from its prior conversation context.
  if (round === 1 && !retryError && !stage.freshSession) {
    return formatStandardPrompt(runDescription, stage);
  }

  // ── 5.2  freshSession with context injection (SAD §5.4, FR-W8) ────
  // New ACP session in the same sandbox/worktree. We inject:
  //   (a) agent's final assistant message from each completed stage
  //   (b) plan.md content
  //   (c) latest approved review summary
  if (stage.freshSession && round === 1 && freshSessionContext) {
    return formatFreshSessionPrompt(runDescription, stage, freshSessionContext);
  }

  // ── 5.3  Request-changes with bundled comments (SAD §5.3.1) ───────
  // This is injected by inject-comments step, not by buildStagePrompt.
  // However, when executeStage re-runs with request_changes, the stage
  // prompt is the continuation prompt (agent already has the comments).
  if (requestChangesComments && requestChangesComments.length > 0) {
    return formatRequestChangesPrompt(runDescription, stage, round);
  }

  // ── 5.4  Retry after failure (SAD §5.3.2, FR-W14) ────────────────
  if (retryError) {
    return formatRetryPrompt(runDescription, stage, retryError);
  }

  // ── Fallback: standard prompt ─────────────────────────────────────
  return formatStandardPrompt(runDescription, stage);
}

// --- Format helpers ------------------------------------------------------ //

function formatStandardPrompt(
  runDescription: string,
  stage: { name: string; promptTemplate: string },
): string {
  return [
    `## Task`,
    ``,
    runDescription,
    ``,
    `## Current Stage: ${stage.name}`,
    ``,
    stage.promptTemplate,
  ].join("\n");
}

function formatFreshSessionPrompt(
  runDescription: string,
  stage: { name: string; promptTemplate: string },
  freshContext: string,
): string {
  return [
    `## Task`,
    ``,
    runDescription,
    ``,
    `## Context from Prior Stages`,
    ``,
    `The following is context from completed stages in this workflow.`,
    `Use this information to continue the work without re-doing completed steps.`,
    ``,
    freshContext,
    ``,
    `## Current Stage: ${stage.name}`,
    ``,
    stage.promptTemplate,
  ].join("\n");
}

function formatRetryPrompt(
  runDescription: string,
  stage: { name: string; promptTemplate: string },
  error: string,
): string {
  // FR-W14: failure-aware message, not a duplicate prompt
  return [
    `## Retry Required`,
    ``,
    `The previous attempt at this stage failed with the following error:`,
    ``,
    "```",
    error,
    "```",
    ``,
    `Please retry the following stage, avoiding the issue described above.`,
    ``,
    `## Task`,
    ``,
    runDescription,
    ``,
    `## Current Stage: ${stage.name}`,
    ``,
    stage.promptTemplate,
  ].join("\n");
}

function formatRequestChangesPrompt(
  runDescription: string,
  stage: { name: string; promptTemplate: string },
  round: number,
): string {
  // The actual comments were already injected by inject-comments step.
  // This prompt reminds the agent of the stage context for the new round.
  return [
    `## Continuation (Round ${round})`,
    ``,
    `Review comments were provided above. Please address all the feedback`,
    `and continue working on the current stage.`,
    ``,
    `## Task`,
    ``,
    runDescription,
    ``,
    `## Current Stage: ${stage.name}`,
    ``,
    stage.promptTemplate,
  ].join("\n");
}

// ------------------------------------------------------------------------- //
// 5.5  Split child prompt (SRD FR-S5)
//
// Not built by buildStagePrompt() — child workflow runs use the proposal
// description as their runDescription, and execute their own template stages.
// The child's first stage uses formatStandardPrompt() with:
//   runDescription = proposal.description
//   stage = first stage from child's workflow template
//
// This is handled automatically by the pipeline: launch-children sets
// workflowRuns.description = proposal.description, and executeStage
// calls buildStagePrompt with the child run's description.
// ------------------------------------------------------------------------- //
```

---

## Appendix A: Traceability Matrix

| CDD Section | SAD Reference | SRD Requirement |
|---|---|---|
| §1 Pipeline | §5.1 Separation of Concerns, §5.2 Invocation | FR-W4, FR-W9, FR-W10 |
| §1 Stage failure | §5.3.2 Stage Failed Hook | FR-W14 |
| §1 Review gate | §5.3.1 Review Decision Hook | FR-W5, FR-R6–R8 |
| §1 Split handling | §5.3.3–5.3.5 Hooks | FR-S1–S13 |
| §1 Finalization | §5.5.2 Worktree Lifecycle, §5.5.3 Git Journal | FR-R10 |
| §2 Hooks | §5.3 Hook Architecture | FR-W5, FR-W14, FR-S3–S4, FR-S12, FR-R10 |
| §3.1 execute-stage | §5.3 Stage Execution Model, §5.4 Session Continuity | FR-W4, FR-W7, FR-W8 |
| §3.2 create-review | §5.3.1 Review Hook | FR-R1, FR-R2 |
| §3.3 inject-comments | §5.3.1 (request_changes) | FR-R7 |
| §3.4 extract-proposals | §5.3.3 Proposal Review Hook | FR-S1, FR-S2 |
| §3.5 launch-children | §5.5.2 Worktree Lifecycle (split) | FR-S4, FR-S5, FR-S6 |
| §3.6 consolidate | §5.5.3 Git Journal (consolidate) | FR-S8, FR-S9, FR-S10 |
| §3.7 finalize | §5.5.3 Git Journal (finalize) | FR-R10 |
| §4 Session Manager | §5.4 ACP Session Continuity | FR-W7, FR-W10, FR-W17, FR-W19, FR-W21 |
| §5 Prompt Builder | §5.3 step 4, §5.4 | FR-W8, FR-W14, FR-S5 |

## Appendix B: Key Design Decisions

1. **Recursive failure handling.** `handleStageFailure` calls itself recursively if a retry also fails. This allows unlimited user retries without loop counters. The `"use workflow"` runtime persists hook state at each suspension, so even with 10 retries the workflow is crash-safe.

2. **Consolidation does NOT merge to target.** Per SAD §5.5.3, consolidation only merges children into the parent worktree. The final `merge → targetBranch` happens in `finalize` at the very end of the pipeline.

3. **awaitCompletion does not hold the mutex.** The session mutex serializes stdin writes, but completion waiting is mutex-free. This allows user interventions (FR-W21) to be injected while the agent is running.

4. **Journal-based git operations.** Both `finalize` and `consolidate` use the `gitOperations` journal table. Each phase is idempotent — on replay, it checks whether the phase was already completed before re-executing.

5. **Child workflows are full pipelines.** `launch-children` starts each child via `start(runWorkflowPipeline)` with an independent `runId`. Children run their own stages, reviews, and finalization. The parent polls their status via `waitForChildren`.
