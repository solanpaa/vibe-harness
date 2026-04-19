// ---------------------------------------------------------------------------
// Review Service (CDD §7)
//
// Auto-create reviews from diffs, generate AI summaries, capture plan.md,
// bundle comments for re-injection into agent conversations.
// ---------------------------------------------------------------------------

import { eq, and, asc } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { Logger } from 'pino';
import type { WorktreeService, DiffResult } from './worktree.js';
import type { SandboxService } from './sandbox.js';
import type { DiffFile } from './diff-parser.js';
import * as schema from '../db/schema.js';
import { AppError } from '../lib/errors.js';

// ── Error classes ────────────────────────────────────────────────────

export class ReviewCreateError extends AppError {
  readonly code = 'REVIEW_CREATE_ERROR';
  readonly httpStatus = 500;
  constructor(runId: string, reason: string) {
    super(`Failed to create review for run '${runId}': ${reason}`, { runId, reason });
  }
}

export class ReviewNotFoundError extends AppError {
  readonly code = 'REVIEW_NOT_FOUND';
  readonly httpStatus = 404;
  constructor(reviewId: string) {
    super(`Review '${reviewId}' not found`, { reviewId });
  }
}

export class RunNotFoundError extends AppError {
  readonly code = 'RUN_NOT_FOUND';
  readonly httpStatus = 404;
  constructor(runId: string) {
    super(`Workflow run '${runId}' not found`, { runId });
  }
}

export class WorktreeNotReadyError extends AppError {
  readonly code = 'WORKTREE_NOT_READY';
  readonly httpStatus = 409;
  constructor(runId: string) {
    super(`Workflow run '${runId}' has no worktree path yet`, { runId });
  }
}

// ── Types ────────────────────────────────────────────────────────────

export interface CreateReviewOptions {
  runId: string;
  stageName: string | null;
  round: number;
  type: 'stage' | 'consolidation';
  worktreePath: string;
  baseBranch: string;
  sandboxName?: string;
}

export interface ReviewResult {
  reviewId: string;
  alreadyExisted: boolean;
}

export interface BundledComments {
  markdown: string;
  commentCount: number;
}

export interface ReviewService {
  createReview(options: CreateReviewOptions): Promise<ReviewResult>;
  bundleCommentsAsPrompt(reviewId: string): Promise<BundledComments>;
  getDiff(runId: string): Promise<DiffResult>;
  capturePlanMarkdown(sandboxName: string): Promise<string | null>;
}

// ── Consolidation sentinel ──────────────────────────────────────────
// SQLite treats each NULL as distinct in UNIQUE indexes, so we use a
// sentinel string for consolidation reviews (see schema.ts).
const CONSOLIDATION_SENTINEL = '__consolidation__';

// ── Factory ─────────────────────────────────────────────────────────

export function createReviewService(deps: {
  logger: Logger;
  db: BetterSQLite3Database<typeof schema>;
  worktreeService: WorktreeService;
  sandboxService: SandboxService;
}): ReviewService {
  const { logger, db, worktreeService, sandboxService } = deps;

  // ── createReview ──────────────────────────────────────────────────

  async function createReview(options: CreateReviewOptions): Promise<ReviewResult> {
    const log = logger.child({
      runId: options.runId,
      stageName: options.stageName,
      round: options.round,
      type: options.type,
    });

    const dbStageName = options.stageName ?? CONSOLIDATION_SENTINEL;

    // Step 1: Check for existing review (idempotent — UNIQUE constraint)
    const existing = db
      .select({ id: schema.reviews.id })
      .from(schema.reviews)
      .where(
        and(
          eq(schema.reviews.workflowRunId, options.runId),
          eq(schema.reviews.stageName, dbStageName),
          eq(schema.reviews.round, options.round),
          eq(schema.reviews.type, options.type),
        ),
      )
      .get();

    if (existing) {
      log.info({ reviewId: existing.id }, 'Review already exists (idempotent)');
      return { reviewId: existing.id, alreadyExisted: true };
    }

    // Step 2: Generate diff via WorktreeService.getDiff()
    log.info('Generating diff for review');
    let diff: DiffResult;
    try {
      diff = await worktreeService.getDiff(options.worktreePath, options.baseBranch);
    } catch (err) {
      throw new ReviewCreateError(
        options.runId,
        `Diff generation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Step 3: Capture plan.md from sandbox (best-effort — never fails the review)
    let planMarkdown: string | null = null;
    if (options.sandboxName) {
      planMarkdown = await capturePlanMarkdown(options.sandboxName);
    }

    // Step 4: Generate AI summary (statistical fallback for now)
    let aiSummary: string;
    try {
      aiSummary = generateAiSummary(diff);
    } catch (err) {
      log.warn({ err }, 'AI summary generation failed, using fallback');
      aiSummary = `${diff.stats.filesChanged} files changed, ${diff.stats.insertions} insertions(+), ${diff.stats.deletions} deletions(-)`;
    }

    // Step 5: Insert review record
    const reviewId = crypto.randomUUID();
    try {
      db.insert(schema.reviews)
        .values({
          id: reviewId,
          workflowRunId: options.runId,
          stageName: dbStageName,
          round: options.round,
          type: options.type,
          status: 'pending_review',
          aiSummary,
          diffSnapshot: diff.rawDiff,
          planMarkdown,
        })
        .run();
    } catch (err) {
      // UNIQUE constraint violation → another concurrent call created it
      if (err instanceof Error && err.message.includes('UNIQUE constraint')) {
        const race = db
          .select({ id: schema.reviews.id })
          .from(schema.reviews)
          .where(
            and(
              eq(schema.reviews.workflowRunId, options.runId),
              eq(schema.reviews.stageName, dbStageName),
              eq(schema.reviews.round, options.round),
              eq(schema.reviews.type, options.type),
            ),
          )
          .get();

        if (race) {
          log.info({ reviewId: race.id }, 'Review created concurrently (idempotent)');
          return { reviewId: race.id, alreadyExisted: true };
        }
      }

      throw new ReviewCreateError(
        options.runId,
        `DB insert failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    log.info({ reviewId }, 'Review created');
    return { reviewId, alreadyExisted: false };
  }

  // ── bundleCommentsAsPrompt ────────────────────────────────────────

  async function bundleCommentsAsPrompt(reviewId: string): Promise<BundledComments> {
    const review = db
      .select({ id: schema.reviews.id, round: schema.reviews.round })
      .from(schema.reviews)
      .where(eq(schema.reviews.id, reviewId))
      .get();

    if (!review) throw new ReviewNotFoundError(reviewId);

    const comments = db
      .select()
      .from(schema.reviewComments)
      .where(eq(schema.reviewComments.reviewId, reviewId))
      .orderBy(asc(schema.reviewComments.filePath), asc(schema.reviewComments.lineNumber))
      .all();

    if (comments.length === 0) {
      return { markdown: '', commentCount: 0 };
    }

    // Group by file — general comments (null filePath) first, then per-file
    const generalComments: string[] = [];
    const fileComments = new Map<string, Array<{ line?: number; body: string }>>();

    for (const comment of comments) {
      if (!comment.filePath) {
        generalComments.push(comment.body);
      } else {
        const existing = fileComments.get(comment.filePath) ?? [];
        existing.push({
          line: comment.lineNumber ?? undefined,
          body: comment.body,
        });
        fileComments.set(comment.filePath, existing);
      }
    }

    // Build markdown
    const lines: string[] = [`## Review Feedback (Round ${review.round})`, ''];

    if (generalComments.length > 0) {
      lines.push('### General Comments', '');
      for (const comment of generalComments) {
        lines.push(`- ${comment}`);
      }
      lines.push('');
    }

    for (const [filePath, fileCommentsList] of fileComments) {
      lines.push(`### File: ${filePath}`, '');
      for (const comment of fileCommentsList) {
        if (comment.line) {
          lines.push(`- **Line ${comment.line}:** ${comment.body}`);
        } else {
          lines.push(`- ${comment.body}`);
        }
      }
      lines.push('');
    }

    lines.push(
      'Please address each comment above. If you disagree with a suggestion, explain your reasoning.',
    );

    return { markdown: lines.join('\n'), commentCount: comments.length };
  }

  // ── getDiff ───────────────────────────────────────────────────────

  async function getDiff(runId: string): Promise<DiffResult> {
    const run = db
      .select({
        worktreePath: schema.workflowRuns.worktreePath,
        baseBranch: schema.workflowRuns.baseBranch,
      })
      .from(schema.workflowRuns)
      .where(eq(schema.workflowRuns.id, runId))
      .get();

    if (!run) throw new RunNotFoundError(runId);
    if (!run.worktreePath) throw new WorktreeNotReadyError(runId);
    if (!run.baseBranch) throw new WorktreeNotReadyError(runId);

    return worktreeService.getDiff(run.worktreePath, run.baseBranch);
  }

  // ── capturePlanMarkdown ───────────────────────────────────────────

  async function capturePlanMarkdown(sandboxName: string): Promise<string | null> {
    try {
      const result = await sandboxService.execCommand(sandboxName, {
        command: ['find', '/', '-name', 'plan.md', '-path', '*session-state*', '-type', 'f'],
      });

      // find exits non-zero when it can't access some dirs (e.g. /root, /proc)
      // but still outputs valid results — check stdout regardless of exit code
      if (!result.stdout.trim()) {
        return null;
      }

      const files = result.stdout.trim().split('\n').filter(Boolean);
      if (files.length === 0) return null;

      // Use the last one found (most recently created session)
      const planPath = files[files.length - 1];
      const catResult = await sandboxService.execCommand(sandboxName, {
        command: ['cat', planPath],
      });

      if (catResult.exitCode === 0 && catResult.stdout.trim()) {
        return catResult.stdout;
      }

      return null;
    } catch {
      return null; // plan.md doesn't exist or sandbox not accessible
    }
  }

  return { createReview, bundleCommentsAsPrompt, getDiff, capturePlanMarkdown };
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Generate a structured summary of a diff.
 * TODO: Replace with LLM call for richer AI summaries.
 */
function generateAiSummary(diff: DiffResult): string {
  const { stats, files } = diff;

  const fileList = files
    .map((f) => {
      const status =
        f.status === 'added'
          ? '🟢 Added'
          : f.status === 'deleted'
            ? '🔴 Deleted'
            : f.status === 'renamed'
              ? '🔵 Renamed'
              : '🟡 Modified';
      const path = f.newPath ?? f.oldPath ?? '(unknown)';
      return `| \`${path}\` | ${status} | +${f.additions} -${f.deletions} |`;
    })
    .join('\n');

  return [
    `**${stats.filesChanged}** files changed, **${stats.insertions}** insertions(+), **${stats.deletions}** deletions(-)`,
    '',
    '| File | Status | Changes |',
    '|------|--------|---------|',
    fileList,
  ].join('\n');
}
