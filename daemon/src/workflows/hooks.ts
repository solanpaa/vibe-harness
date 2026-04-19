// ---------------------------------------------------------------------------
// Workflow Hook Definitions (CDD-workflow §2)
//
// Each hook defines the response schema the workflow expects when resumed.
// Hook tokens encode operation type + context to prevent collisions.
// ---------------------------------------------------------------------------

import { defineHook } from 'workflow';
import { z } from 'zod';

// -------------------------------------------------------------------------- //
// 2.1  Review Decision Hook (SAD §5.3.1)
//
// Suspends after create-review. Resumed by:
//   POST /api/reviews/:id/approve   → { action: 'approve' }
//   POST /api/reviews/:id/request-changes → { action: 'request_changes', comments }
// -------------------------------------------------------------------------- //

const reviewCommentSchema = z.object({
  id: z.string().optional(),
  filePath: z.string().nullable(),
  lineNumber: z.number().nullable().optional(),
  side: z.enum(['left', 'right']).nullable().optional(),
  body: z.string(),
});

export type ReviewComment = z.infer<typeof reviewCommentSchema>;

// SplitConfigSnapshot mirror as zod (kept inline to avoid forcing daemon
// to import shared zod schemas; structurally compatible with the shared
// `SplitConfigSnapshot` type).
const splitConfigSnapshotSchema = z.object({
  sourceStageName: z.string(),
  sourceReviewId: z.string(),
  triggeredAt: z.string(),
  splitterPromptTemplate: z.string(),
  extraDescription: z.string(),
  effectiveSplitterPrompt: z.string(),
  postSplitStages: z.array(z.object({
    name: z.string(),
    splittable: z.boolean().optional(),
    promptTemplate: z.string(),
    reviewRequired: z.boolean(),
    autoAdvance: z.boolean(),
    freshSession: z.boolean(),
    model: z.string().optional(),
    isFinal: z.boolean().optional(),
  })),
  skippedTemplateStages: z.array(z.string()),
});

export const reviewDecisionResponseSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('approve') }),
  z.object({
    action: z.literal('request_changes'),
    comments: z.array(reviewCommentSchema).min(1),
  }),
  z.object({
    action: z.literal('split'),
    extraDescription: z.string(),
    splitConfig: splitConfigSnapshotSchema,
  }),
  z.object({ action: z.literal('cancel') }),
]);

export type ReviewDecisionResponse = z.infer<typeof reviewDecisionResponseSchema>;

export const reviewDecisionHook = defineHook<ReviewDecisionResponse>({
  schema: reviewDecisionResponseSchema,
});

// -------------------------------------------------------------------------- //
// 2.2  Stage Failed Hook (SAD §5.3.2)
//
// Suspends when a stage execution fails. Resumed by:
//   POST /api/runs/:id/retry-stage  → { action: 'retry' }
//   POST /api/runs/:id/skip-stage   → { action: 'skip' }
//   PATCH /api/runs/:id/cancel      → { action: 'cancel' }
// -------------------------------------------------------------------------- //

export const stageFailedResponseSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('retry') }),
  z.object({ action: z.literal('skip') }),
  z.object({ action: z.literal('cancel') }),
]);

export type StageFailedResponse = z.infer<typeof stageFailedResponseSchema>;

export const stageFailedHook = defineHook<StageFailedResponse>({
  schema: stageFailedResponseSchema,
});

// -------------------------------------------------------------------------- //
// 2.3  Proposal Review Hook (SAD §5.3.3)
//
// Suspends after split-stage proposal extraction. User reviews/edits
// proposals in GUI, then launches selected ones. Resumed by:
//   POST /api/proposals/launch → { proposalIds: [...] }
// -------------------------------------------------------------------------- //

export const proposalReviewResponseSchema = z.object({
  proposalIds: z.array(z.string()),
});

export type ProposalReviewResponse = z.infer<typeof proposalReviewResponseSchema>;

export const proposalReviewHook = defineHook<ProposalReviewResponse>({
  schema: proposalReviewResponseSchema,
});

// -------------------------------------------------------------------------- //
// 2.4  Parallel Completion Hook (SAD §5.3.4)
//
// Suspends when children reach terminal state but some failed/cancelled.
// Skipped if all children completed successfully.
// -------------------------------------------------------------------------- //

export const parallelCompletionResponseSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('consolidate_completed') }),
  z.object({
    action: z.literal('retry'),
    childRunIds: z.array(z.string()).min(1),
  }),
  z.object({ action: z.literal('cancel') }),
]);

export type ParallelCompletionResponse = z.infer<typeof parallelCompletionResponseSchema>;

export const parallelCompletionHook = defineHook<ParallelCompletionResponse>({
  schema: parallelCompletionResponseSchema,
});

// -------------------------------------------------------------------------- //
// 2.5  Conflict Resolution Hook (SAD §5.3.6)
//
// Suspends when finalization rebase or consolidation merge hits a conflict.
// -------------------------------------------------------------------------- //

export const conflictResolutionResponseSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('retry') }),
  z.object({ action: z.literal('cancel') }),
]);

export type ConflictResolutionResponse = z.infer<typeof conflictResolutionResponseSchema>;

export const conflictResolutionHook = defineHook<ConflictResolutionResponse>({
  schema: conflictResolutionResponseSchema,
});
