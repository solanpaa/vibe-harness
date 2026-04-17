// ---------------------------------------------------------------------------
// Review Routes (CDD-workflow §7 — Hook resume wiring)
//
// Endpoints for approving and requesting changes on reviews.
// Uses the hookResumes outbox pattern for crash safety.
// ---------------------------------------------------------------------------

import { Hono } from 'hono';
import { eq, and, isNull } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import * as schema from '../db/schema.js';
import { logger } from '../lib/logger.js';
import { reviewDecisionHook, type ReviewComment } from '../workflows/hooks.js';
import { reviewToken } from '../workflows/hookTokens.js';
import { defaultPostSplitStagesSchema } from '../lib/validation/workflows.js';
import { z } from 'zod';


const reviews = new Hono();

// ── GET /api/reviews — List reviews ──────────────────────────────────

reviews.get('/api/reviews', (c) => {
  const db = getDb();
  const runId = c.req.query('runId');

  const allReviews = runId
    ? db.select().from(schema.reviews).where(eq(schema.reviews.workflowRunId, runId)).all()
    : db.select().from(schema.reviews).all();

  return c.json({ reviews: allReviews });
});

// ── GET /api/reviews/:id — Review detail with comments ──────────────

reviews.get('/api/reviews/:id', (c) => {
  const db = getDb();
  const reviewId = c.req.param('id');

  const review = db
    .select()
    .from(schema.reviews)
    .where(eq(schema.reviews.id, reviewId))
    .get();

  if (!review) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Review not found' } }, 404);
  }

  const comments = db
    .select()
    .from(schema.reviewComments)
    .where(eq(schema.reviewComments.reviewId, reviewId))
    .all();

  // Find associated stage execution
  const stageExecution = db
    .select()
    .from(schema.stageExecutions)
    .where(
      and(
        eq(schema.stageExecutions.workflowRunId, review.workflowRunId),
        eq(schema.stageExecutions.stageName, review.stageName),
      ),
    )
    .get() ?? null;

  return c.json({ review, comments, stageExecution });
});

// ── POST /api/reviews/:id/approve — Resume reviewDecisionHook ───────

reviews.post('/api/reviews/:id/approve', async (c) => {
  const db = getDb();
  const reviewId = c.req.param('id');

  // Atomic claim (rubber-duck H1): flip status in a single conditional
  // update so concurrent approve/split/request-changes callers can't both
  // pass the precheck.
  const claim = db.update(schema.reviews)
    .set({ status: 'approved' })
    .where(
      and(
        eq(schema.reviews.id, reviewId),
        eq(schema.reviews.status, 'pending_review'),
      ),
    )
    .run();

  if (claim.changes === 0) {
    const current = db.select({ status: schema.reviews.status })
      .from(schema.reviews)
      .where(eq(schema.reviews.id, reviewId))
      .get();
    if (!current) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Review not found' } }, 404);
    }
    return c.json(
      { error: { code: 'CONFLICT', message: `Review is not pending (current: ${current.status})` } },
      409,
    );
  }

  const review = db
    .select()
    .from(schema.reviews)
    .where(eq(schema.reviews.id, reviewId))
    .get();

  if (!review) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Review not found' } }, 404);
  }

  const hookToken = reviewToken(reviewId);
  const payload = { action: 'approve' as const };

  try {
    // Outbox pattern: write first, resume, delete on success
    const outboxId = crypto.randomUUID();
    db.insert(schema.hookResumes)
      .values({
        id: outboxId,
        hookToken,
        action: JSON.stringify(payload),
      })
      .run();

    await reviewDecisionHook.resume(hookToken, payload);

    db.delete(schema.hookResumes)
      .where(eq(schema.hookResumes.id, outboxId))
      .run();

    logger.info({ reviewId }, 'Review approved');
    return c.json({ status: 'approved' });
  } catch (err) {
    // Rollback claim (rubber-duck C2)
    logger.error({ err, reviewId }, 'Failed to resume review hook (approve); rolling back claim');
    try {
      db.update(schema.reviews)
        .set({ status: 'pending_review' })
        .where(eq(schema.reviews.id, reviewId))
        .run();
    } catch (rollbackErr) {
      logger.error({ err: rollbackErr, reviewId }, 'Rollback of approve claim failed');
    }
    return c.json(
      { error: { code: 'HOOK_RESUME_ERROR', message: 'Failed to resume review hook' } },
      500,
    );
  }
});

// ── POST /api/reviews/:id/request-changes — Resume with comments ────

const requestChangesSchema = z.object({
  comments: z.array(z.object({
    filePath: z.string().nullable(),
    lineNumber: z.number().nullable().optional(),
    side: z.enum(['left', 'right']).nullable().optional(),
    body: z.string().min(1),
  })).min(1),
});

reviews.post('/api/reviews/:id/request-changes', async (c) => {
  const db = getDb();
  const reviewId = c.req.param('id');

  const body = await c.req.json();
  const parsed = requestChangesSchema.safeParse(body);

  if (!parsed.success) {
    return c.json(
      { error: { code: 'VALIDATION_ERROR', message: 'Invalid input', details: parsed.error.flatten() } },
      400,
    );
  }

  // Pre-read review to apply type-specific guards (consolidation rejection).
  const review = db
    .select()
    .from(schema.reviews)
    .where(eq(schema.reviews.id, reviewId))
    .get();

  if (!review) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Review not found' } }, 404);
  }

  // Reject request_changes for consolidation reviews (Fix #11)
  if (review.type === 'consolidation') {
    return c.json(
      { error: { code: 'CONFLICT', message: 'Cannot request changes on consolidation reviews. Cancel and re-run failed children instead.' } },
      409,
    );
  }

  // Atomic claim (rubber-duck H1)
  const claim = db.update(schema.reviews)
    .set({ status: 'changes_requested' })
    .where(
      and(
        eq(schema.reviews.id, reviewId),
        eq(schema.reviews.status, 'pending_review'),
      ),
    )
    .run();

  if (claim.changes === 0) {
    return c.json(
      { error: { code: 'CONFLICT', message: `Review is not pending (current: ${review.status})` } },
      409,
    );
  }

  // Persist the review comments
  for (const comment of parsed.data.comments) {
    db.insert(schema.reviewComments)
      .values({
        reviewId,
        filePath: comment.filePath,
        lineNumber: comment.lineNumber ?? null,
        side: comment.side ?? null,
        body: comment.body,
      })
      .run();
  }

  const hookToken = reviewToken(reviewId);
  const payload = {
    action: 'request_changes' as const,
    comments: parsed.data.comments.map((c) => ({
      filePath: c.filePath,
      lineNumber: c.lineNumber ?? null,
      side: c.side ?? null,
      body: c.body,
    })),
  };

  try {
    // Outbox pattern
    const outboxId = crypto.randomUUID();
    db.insert(schema.hookResumes)
      .values({
        id: outboxId,
        hookToken,
        action: JSON.stringify(payload),
      })
      .run();

    await reviewDecisionHook.resume(hookToken, payload);

    db.delete(schema.hookResumes)
      .where(eq(schema.hookResumes.id, outboxId))
      .run();

    logger.info({ reviewId, commentCount: parsed.data.comments.length }, 'Changes requested on review');
    return c.json({ status: 'changes_requested', commentCount: parsed.data.comments.length });
  } catch (err) {
    // Rollback claim (rubber-duck C2). Note: comments persisted will remain
    // (they're a local record of the attempt); on retry the user will re-submit.
    logger.error({ err, reviewId }, 'Failed to resume review hook (request_changes); rolling back claim');
    try {
      db.update(schema.reviews)
        .set({ status: 'pending_review' })
        .where(eq(schema.reviews.id, reviewId))
        .run();
    } catch (rollbackErr) {
      logger.error({ err: rollbackErr, reviewId }, 'Rollback of request-changes claim failed');
    }
    return c.json(
      { error: { code: 'HOOK_RESUME_ERROR', message: 'Failed to resume review hook' } },
      500,
    );
  }
});

// ── POST /api/reviews/:id/split — Resume with split decision ────────
//
// Triggers the ad-hoc split sub-pipeline (rubber-duck blockers #1, #3, #4).
// The route resolves and SNAPSHOTS the splitter prompt + post-split stages
// from current global settings at submit time, persists the snapshot to
// workflow_runs.split_config_json, and embeds it in the hook resume payload.
// The workflow then reads only from the snapshot — settings drift after this
// point will not affect the in-flight run.

const splitRequestSchema = z.object({
  extraDescription: z.string().max(20000).default(''),
});

reviews.post('/api/reviews/:id/split', async (c) => {
  const db = getDb();
  const reviewId = c.req.param('id');

  const rawBody = await c.req.json().catch(() => ({}));
  const parsed = splitRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.json(
      { error: { code: 'VALIDATION_ERROR', message: 'Invalid input', details: parsed.error.flatten() } },
      400,
    );
  }

  const review = db.select().from(schema.reviews)
    .where(eq(schema.reviews.id, reviewId)).get();
  if (!review) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Review not found' } }, 404);
  }
  if (review.status !== 'pending_review') {
    return c.json(
      { error: { code: 'CONFLICT', message: `Review is not pending (current: ${review.status})` } },
      409,
    );
  }
  if (review.type !== 'stage') {
    return c.json(
      { error: { code: 'CONFLICT', message: 'Split is only allowed on stage reviews' } },
      409,
    );
  }

  const run = db.select().from(schema.workflowRuns)
    .where(eq(schema.workflowRuns.id, review.workflowRunId)).get();
  if (!run) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Workflow run not found' } }, 404);
  }
  if (run.parentRunId) {
    return c.json(
      { error: { code: 'CONFLICT', message: 'Cannot split a child workflow run (no recursive split)' } },
      409,
    );
  }
  if (run.splitConfigJson) {
    return c.json(
      { error: { code: 'CONFLICT', message: 'Run has already been split' } },
      409,
    );
  }

  // Load template + locate the source stage
  const template = db.select().from(schema.workflowTemplates)
    .where(eq(schema.workflowTemplates.id, run.workflowTemplateId)).get();
  if (!template) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Workflow template not found' } }, 404);
  }
  let templateStages: Array<{ name: string; splittable?: boolean }>;
  try {
    templateStages = JSON.parse(template.stages);
  } catch {
    return c.json(
      { error: { code: 'CORRUPT_DATA', message: 'Workflow template stages JSON is corrupt' } },
      500,
    );
  }
  const sourceIdx = templateStages.findIndex((s) => s.name === review.stageName);
  if (sourceIdx < 0) {
    return c.json(
      { error: { code: 'CONFLICT', message: 'Review stage no longer exists in the template' } },
      409,
    );
  }
  const sourceStage = templateStages[sourceIdx];
  if (!sourceStage.splittable) {
    return c.json(
      { error: { code: 'CONFLICT', message: `Stage "${sourceStage.name}" is not splittable` } },
      409,
    );
  }
  const skippedTemplateStages = templateStages
    .slice(sourceIdx + 1)
    .map((s) => s.name);

  // Snapshot global settings NOW (rubber-duck blocker #1)
  const splitterPromptRow = db.select().from(schema.settings)
    .where(eq(schema.settings.key, 'defaultSplitterPromptTemplate')).get();
  const postSplitRow = db.select().from(schema.settings)
    .where(eq(schema.settings.key, 'defaultPostSplitStages')).get();

  if (!splitterPromptRow?.value) {
    return c.json(
      { error: { code: 'CONFIG_MISSING', message: 'defaultSplitterPromptTemplate setting is not configured' } },
      500,
    );
  }

  let postSplitStages: Array<z.infer<typeof defaultPostSplitStagesSchema>[number]> = [];
  if (postSplitRow?.value) {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(postSplitRow.value);
    } catch {
      return c.json(
        { error: { code: 'CORRUPT_DATA', message: 'defaultPostSplitStages setting is not valid JSON' } },
        500,
      );
    }
    const parsedStages = defaultPostSplitStagesSchema.safeParse(parsedJson);
    if (!parsedStages.success) {
      return c.json(
        { error: { code: 'CORRUPT_DATA', message: 'defaultPostSplitStages setting is invalid', details: parsedStages.error.flatten() } },
        500,
      );
    }
    postSplitStages = parsedStages.data;
  }

  // Compose the effective splitter prompt. Use a function-form replacer so
  // that `$`/`$&`/`$1` etc. inside description or extra are NOT interpreted
  // as regex back-references, AND a single-pass regex so description
  // containing `{{extra}}` cannot trigger a second interpolation
  // (rubber-duck C1 / Medium).
  const splitterPromptTemplate = splitterPromptRow.value;
  const extraDescription = parsed.data.extraDescription;
  const effectiveSplitterPrompt = splitterPromptTemplate.replace(
    /\{\{(description|extra)\}\}/g,
    (_match: string, key: string) =>
      key === 'description' ? (run.description ?? '') : extraDescription,
  );

  const splitConfig = {
    sourceStageName: sourceStage.name,
    sourceReviewId: reviewId,
    triggeredAt: new Date().toISOString(),
    splitterPromptTemplate,
    extraDescription,
    effectiveSplitterPrompt,
    postSplitStages,
    skippedTemplateStages,
  };

  // Atomic claim (rubber-duck H1): conditionally mark the review approved AND
  // set split_config_json in a single transaction. If either row has moved
  // on since we read it, abort with 409. This closes the race between
  // concurrent approve/request-changes/split and concurrent split+split.
  const claim = db.transaction((tx) => {
    const reviewUpdate = tx.update(schema.reviews)
      .set({ status: 'approved' })
      .where(
        and(
          eq(schema.reviews.id, reviewId),
          eq(schema.reviews.status, 'pending_review'),
        ),
      )
      .run();
    if (reviewUpdate.changes === 0) {
      return { ok: false as const, reason: 'review_not_pending' as const };
    }

    const runUpdate = tx.update(schema.workflowRuns)
      .set({ splitConfigJson: JSON.stringify(splitConfig) })
      .where(
        and(
          eq(schema.workflowRuns.id, run.id),
          isNull(schema.workflowRuns.splitConfigJson),
        ),
      )
      .run();
    if (runUpdate.changes === 0) {
      // Another split already claimed the run. Revert the review-status flip.
      tx.update(schema.reviews)
        .set({ status: 'pending_review' })
        .where(eq(schema.reviews.id, reviewId))
        .run();
      return { ok: false as const, reason: 'run_already_split' as const };
    }

    return { ok: true as const };
  });

  if (!claim.ok) {
    return c.json(
      {
        error: {
          code: 'CONFLICT',
          message:
            claim.reason === 'run_already_split'
              ? 'Run has already been split'
              : 'Review is not pending',
        },
      },
      409,
    );
  }

  const hookToken = reviewToken(reviewId);
  const payload = {
    action: 'split' as const,
    extraDescription,
    splitConfig,
  };

  try {
    const outboxId = crypto.randomUUID();
    db.insert(schema.hookResumes)
      .values({
        id: outboxId,
        hookToken,
        action: JSON.stringify(payload),
      })
      .run();

    await reviewDecisionHook.resume(hookToken, payload);

    db.delete(schema.hookResumes)
      .where(eq(schema.hookResumes.id, outboxId))
      .run();

    logger.info(
      { reviewId, runId: run.id, sourceStage: sourceStage.name, postSplitCount: postSplitStages.length },
      'Review split — ad-hoc split sub-pipeline triggered',
    );
    return c.json({ status: 'split', splitConfig });
  } catch (err) {
    // Rollback the claim so the user can retry (rubber-duck C2).
    logger.error({ err, reviewId }, 'Failed to resume review hook (split); rolling back claim');
    try {
      db.transaction((tx) => {
        tx.update(schema.reviews)
          .set({ status: 'pending_review' })
          .where(eq(schema.reviews.id, reviewId))
          .run();
        tx.update(schema.workflowRuns)
          .set({ splitConfigJson: null })
          .where(eq(schema.workflowRuns.id, run.id))
          .run();
      });
    } catch (rollbackErr) {
      logger.error({ err: rollbackErr, reviewId }, 'Rollback of split claim failed');
    }
    return c.json(
      { error: { code: 'HOOK_RESUME_ERROR', message: 'Failed to resume review hook' } },
      500,
    );
  }
});

export { reviews };
