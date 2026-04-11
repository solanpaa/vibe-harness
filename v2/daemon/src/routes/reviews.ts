// ---------------------------------------------------------------------------
// Review Routes (CDD-workflow §7 — Hook resume wiring)
//
// Endpoints for approving and requesting changes on reviews.
// Uses the hookResumes outbox pattern for crash safety.
// ---------------------------------------------------------------------------

import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import * as schema from '../db/schema.js';
import { logger } from '../lib/logger.js';
import { reviewDecisionHook, type ReviewComment } from '../workflows/hooks.js';
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

  return c.json({ ...review, comments });
});

// ── POST /api/reviews/:id/approve — Resume reviewDecisionHook ───────

reviews.post('/api/reviews/:id/approve', async (c) => {
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

  if (review.status !== 'pending_review') {
    return c.json(
      { error: { code: 'CONFLICT', message: `Review is not pending (current: ${review.status})` } },
      409,
    );
  }

  const hookToken = `review:${reviewId}`;
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

    // Update review status
    db.update(schema.reviews)
      .set({ status: 'approved' })
      .where(eq(schema.reviews.id, reviewId))
      .run();

    logger.info({ reviewId }, 'Review approved');
    return c.json({ status: 'approved' });
  } catch (err) {
    logger.error({ err, reviewId }, 'Failed to resume review hook (approve)');
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

  const review = db
    .select()
    .from(schema.reviews)
    .where(eq(schema.reviews.id, reviewId))
    .get();

  if (!review) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Review not found' } }, 404);
  }

  if (review.status !== 'pending_review') {
    return c.json(
      { error: { code: 'CONFLICT', message: `Review is not pending (current: ${review.status})` } },
      409,
    );
  }

  // Reject request_changes for consolidation reviews (Fix #11)
  if (review.type === 'consolidation') {
    return c.json(
      { error: { code: 'CONFLICT', message: 'Cannot request changes on consolidation reviews. Cancel and re-run failed children instead.' } },
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

  const hookToken = `review:${reviewId}`;
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

    // Update review status
    db.update(schema.reviews)
      .set({ status: 'changes_requested' })
      .where(eq(schema.reviews.id, reviewId))
      .run();

    logger.info({ reviewId, commentCount: parsed.data.comments.length }, 'Changes requested on review');
    return c.json({ status: 'changes_requested', commentCount: parsed.data.comments.length });
  } catch (err) {
    logger.error({ err, reviewId }, 'Failed to resume review hook (request_changes)');
    return c.json(
      { error: { code: 'HOOK_RESUME_ERROR', message: 'Failed to resume review hook' } },
      500,
    );
  }
});

export { reviews };
