// ---------------------------------------------------------------------------
// Proposal Routes (CDD §11, SAD §5.3.3)
//
// CRUD for split proposals + launch endpoint that resumes the
// proposalReviewHook to start child workflows.
// ---------------------------------------------------------------------------

import { Hono } from 'hono';
import { getDb } from '../db/index.js';
import * as schema from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { logger } from '../lib/logger.js';
import { proposalReviewHook } from '../workflows/hooks.js';
import {
  createProposalService,
  ProposalNotFoundError,
  ProposalValidationError,
} from '../services/proposal-service.js';
import { z } from 'zod';

const proposals = new Hono();

// ── Helper: get proposal service (lazy, uses current db) ─────────────

function getProposalService() {
  return createProposalService({
    logger,
    db: getDb(),
  });
}

// ── GET /api/proposals?runId=X&stageName=Y — List proposals ──────────

proposals.get('/api/proposals', (c) => {
  const runId = c.req.query('runId');
  if (!runId) {
    return c.json(
      { error: { code: 'VALIDATION_ERROR', message: 'runId query parameter is required' } },
      400,
    );
  }

  const stageName = c.req.query('stageName') ?? undefined;
  const status = c.req.query('status') ?? undefined;

  try {
    const service = getProposalService();
    const result = service.listProposals(runId, { stageName, status });
    return c.json({ proposals: result });
  } catch (err) {
    return handleServiceError(c, err);
  }
});

// ── POST /api/proposals — Create proposal (user-added) ───────────────

const createProposalSchema = z.object({
  workflowRunId: z.string().uuid(),
  stageName: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  affectedFiles: z.array(z.string()).optional(),
  dependsOn: z.array(z.string()).optional(),
  workflowTemplateOverride: z.string().uuid().optional(),
  sortOrder: z.number().int().optional(),
});

proposals.post('/api/proposals', (c) => {
  return handleAsync(c, async () => {
    const body = await c.req.json();
    const parsed = createProposalSchema.safeParse(body);

    if (!parsed.success) {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: 'Invalid input', details: parsed.error.flatten() } },
        400,
      );
    }

    const service = getProposalService();
    const proposal = service.createProposal(parsed.data);

    logger.info({ proposalId: proposal.id, runId: parsed.data.workflowRunId }, 'Proposal created');
    return c.json(proposal, 201);
  });
});

// ── PATCH /api/proposals/:id — Edit proposal ─────────────────────────

const updateProposalSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  affectedFiles: z.array(z.string()).optional(),
  dependsOn: z.array(z.string()).optional(),
  workflowTemplateOverride: z.string().uuid().nullable().optional(),
  sortOrder: z.number().int().optional(),
  status: z.enum(['proposed', 'approved', 'discarded']).optional(),
});

proposals.patch('/api/proposals/:id', (c) => {
  return handleAsync(c, async () => {
    const proposalId = c.req.param('id');
    const body = await c.req.json();
    const parsed = updateProposalSchema.safeParse(body);

    if (!parsed.success) {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: 'Invalid input', details: parsed.error.flatten() } },
        400,
      );
    }

    const service = getProposalService();
    const updated = service.updateProposal(proposalId, parsed.data);

    logger.info({ proposalId }, 'Proposal updated');
    return c.json(updated);
  });
});

// ── DELETE /api/proposals/:id — Delete proposal ──────────────────────

proposals.delete('/api/proposals/:id', (c) => {
  const proposalId = c.req.param('id');

  try {
    const service = getProposalService();
    service.deleteProposal(proposalId);

    logger.info({ proposalId }, 'Proposal deleted');
    return c.json({ status: 'deleted' });
  } catch (err) {
    return handleServiceError(c, err);
  }
});

// ── POST /api/proposals/launch — Launch selected proposals ───────────
//
// Resumes the proposalReviewHook with the selected proposal IDs.
// The workflow pipeline picks up from the hook suspension point and
// calls launchChildren with the selected proposals. (SAD §5.3.3)

const launchProposalsSchema = z.object({
  runId: z.string().uuid(),
  proposalIds: z.array(z.string().uuid()).min(1),
});

proposals.post('/api/proposals/launch', (c) => {
  return handleAsync(c, async () => {
    const body = await c.req.json();
    const parsed = launchProposalsSchema.safeParse(body);

    if (!parsed.success) {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: 'Invalid input', details: parsed.error.flatten() } },
        400,
      );
    }

    const { runId, proposalIds } = parsed.data;
    const db = getDb();

    // Verify the run is in the correct state
    const run = db
      .select({ status: schema.workflowRuns.status })
      .from(schema.workflowRuns)
      .where(eq(schema.workflowRuns.id, runId))
      .get();

    if (!run) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Workflow run not found' } }, 404);
    }

    if (run.status !== 'awaiting_proposals') {
      return c.json(
        { error: { code: 'CONFLICT', message: `Run is not awaiting proposals (current: ${run.status})` } },
        409,
      );
    }

    // Validate each proposal belongs to this run and has a launchable status
    for (const proposalId of proposalIds) {
      const proposal = db
        .select({
          id: schema.proposals.id,
          workflowRunId: schema.proposals.workflowRunId,
          status: schema.proposals.status,
        })
        .from(schema.proposals)
        .where(eq(schema.proposals.id, proposalId))
        .get();

      if (!proposal || proposal.workflowRunId !== runId) {
        return c.json(
          { error: { code: 'VALIDATION_ERROR', message: `Proposal ${proposalId} does not belong to run ${runId}` } },
          400,
        );
      }

      if (proposal.status !== 'proposed' && proposal.status !== 'approved') {
        return c.json(
          { error: { code: 'VALIDATION_ERROR', message: `Proposal ${proposalId} has non-launchable status '${proposal.status}'` } },
          400,
        );
      }
    }

    // Mark selected proposals as approved
    const service = getProposalService();
    for (const proposalId of proposalIds) {
      try {
        service.updateProposal(proposalId, { status: 'approved' });
      } catch {
        // Proposal may already be approved — best effort
      }
    }

    // Resume the proposalReviewHook via outbox pattern.
    // On crash, any un-deleted row in hookResumes is replayed by
    // replayPendingHookResumes() in lib/reconcile.ts on startup.
    const hookToken = `proposals:${runId}`;
    const payload = { proposalIds };

    try {
      const outboxId = crypto.randomUUID();
      db.insert(schema.hookResumes)
        .values({
          id: outboxId,
          hookToken,
          action: JSON.stringify(payload),
        })
        .run();

      await proposalReviewHook.resume(hookToken, payload);

      db.delete(schema.hookResumes)
        .where(eq(schema.hookResumes.id, outboxId))
        .run();

      logger.info({ runId, proposalCount: proposalIds.length }, 'Proposals launched');
      return c.json({ status: 'launched', proposalIds });
    } catch (err) {
      logger.error({ err, runId }, 'Failed to resume proposal review hook');
      return c.json(
        { error: { code: 'HOOK_RESUME_ERROR', message: 'Failed to resume proposal review hook' } },
        500,
      );
    }
  });
});

// ── Error helpers ────────────────────────────────────────────────────

function handleServiceError(c: any, err: unknown) {
  if (err instanceof ProposalNotFoundError) {
    return c.json(err.toJSON(), 404);
  }
  if (err instanceof ProposalValidationError) {
    return c.json(err.toJSON(), 409);
  }
  logger.error({ err }, 'Unexpected error in proposals route');
  return c.json(
    { error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } },
    500,
  );
}

async function handleAsync(c: any, fn: () => Promise<any>) {
  try {
    return await fn();
  } catch (err) {
    return handleServiceError(c, err);
  }
}

export { proposals };
