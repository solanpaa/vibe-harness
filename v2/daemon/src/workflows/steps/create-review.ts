// ---------------------------------------------------------------------------
// Create Review Step (CDD-workflow §3.2)
//
// Generates a diff snapshot, captures plan.md, creates a review record.
// Idempotent via UNIQUE(workflowRunId, stageName, round, type).
// ---------------------------------------------------------------------------
"use step";

import { getDb } from '../../db/index.js';
import * as schema from '../../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { logger } from '../../lib/logger.js';
import type { ReviewService } from '../../services/review-service.js';

// ── Types ────────────────────────────────────────────────────────────

export interface CreateReviewInput {
  runId: string;
  stageName: string | null;
  round: number;
  type: 'stage' | 'consolidation';
  lastAssistantMessage: string | null;
  planMarkdown: string | null;
}

export interface CreateReviewOutput {
  id: string;
  diffSnapshot: string;
  aiSummary: string | null;
}

export interface CreateReviewDeps {
  reviewService: ReviewService;
}

function resolveGlobalDeps(): CreateReviewDeps {
  const deps = (globalThis as any).__vibe_pipeline_deps__;
  if (!deps) throw new Error('Pipeline deps not initialized');
  return deps;
}

// Consolidation sentinel (matches schema.ts convention)
const CONSOLIDATION_SENTINEL = '__consolidation__';

// ── Step implementation ──────────────────────────────────────────────

export async function createReview(
  input: CreateReviewInput,
): Promise<CreateReviewOutput> {
  const { runId, stageName, round, type } = input;
  const log = logger.child({ runId, stageName, round, type });
  const db = getDb();
  const { reviewService } = resolveGlobalDeps();
  const dbStageName = stageName ?? CONSOLIDATION_SENTINEL;

  // ── Idempotency: UNIQUE(workflowRunId, stageName, round, type) ────
  const existing = db
    .select()
    .from(schema.reviews)
    .where(
      and(
        eq(schema.reviews.workflowRunId, runId),
        eq(schema.reviews.stageName, dbStageName),
        eq(schema.reviews.round, round),
        eq(schema.reviews.type, type),
      ),
    )
    .get();

  if (existing) {
    log.info({ reviewId: existing.id }, 'Review already exists, returning cached');
    return {
      id: existing.id,
      diffSnapshot: existing.diffSnapshot ?? '',
      aiSummary: existing.aiSummary,
    };
  }

  // ── Look up run for worktree path ─────────────────────────────────
  const run = db
    .select({
      worktreePath: schema.workflowRuns.worktreePath,
      baseBranch: schema.workflowRuns.baseBranch,
      sandboxId: schema.workflowRuns.sandboxId,
    })
    .from(schema.workflowRuns)
    .where(eq(schema.workflowRuns.id, runId))
    .get();

  if (!run?.worktreePath) {
    throw new Error(`Workflow run ${runId} has no worktree path`);
  }

  // ── Generate diff via reviewService ───────────────────────────────
  const reviewResult = await reviewService.createReview({
    runId,
    stageName: dbStageName,
    round,
    type,
    worktreePath: run.worktreePath,
    baseBranch: run.baseBranch ?? 'main',
    sandboxName: run.sandboxId ?? undefined,
  });

  // Fetch the created review to return its fields
  const created = db
    .select()
    .from(schema.reviews)
    .where(eq(schema.reviews.id, reviewResult.reviewId))
    .get();

  log.info({ reviewId: reviewResult.reviewId }, 'Review created');

  return {
    id: reviewResult.reviewId,
    diffSnapshot: created?.diffSnapshot ?? '',
    aiSummary: created?.aiSummary ?? null,
  };
}
