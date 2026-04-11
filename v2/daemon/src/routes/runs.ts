// ---------------------------------------------------------------------------
// Workflow Runs API Routes (CDD-workflow §6)
//
// Manages workflow run lifecycle: create, list, detail, cancel, retry, skip,
// and message (intervention). Hooks into the durable workflow engine.
// ---------------------------------------------------------------------------

import { Hono } from 'hono';
import { eq, and, desc } from 'drizzle-orm';
import { start, resumeHook } from 'workflow/api';
import { execFileSync } from 'node:child_process';
import { getDb } from '../db/index.js';
import * as schema from '../db/schema.js';
import { logger } from '../lib/logger.js';
import { runWorkflowPipeline, type PipelineDeps } from '../workflows/pipeline.js';
import { setPipelineDeps as setPipelineDepsInternal } from '../workflows/pipeline-deps.js';
import {
  stageFailedHook,
  reviewDecisionHook,
  conflictResolutionHook,
  proposalReviewHook,
} from '../workflows/hooks.js';
import { z } from 'zod';

const runs = new Hono();

// ── Helper: get pipeline deps from app context ───────────────────────
// In production, these would come from a DI container. For now we use
// a simple module-level holder that must be initialized at startup.

let pipelineDeps: PipelineDeps | null = null;

export function setPipelineDeps(deps: PipelineDeps): void {
  pipelineDeps = deps;
  // Also set on the pipeline module so the workflow can resolve deps on replay
  setPipelineDepsInternal(deps);
}

function getDeps(): PipelineDeps {
  if (!pipelineDeps) {
    throw new Error('Pipeline dependencies not initialized. Call setPipelineDeps() at startup.');
  }
  return pipelineDeps;
}

// ── POST /api/runs — Create and start a workflow run ─────────────────

const createRunSchema = z.object({
  workflowTemplateId: z.string().uuid(),
  projectId: z.string().uuid(),
  agentDefinitionId: z.string().uuid(),
  description: z.string().optional(),
  title: z.string().optional(),
  baseBranch: z.string().optional().default('main'),
  targetBranch: z.string().optional(),
  model: z.string().optional(),
  credentialSetId: z.string().uuid().optional(),
});

runs.post('/api/runs', async (c) => {
  const body = await c.req.json();
  const parsed = createRunSchema.safeParse(body);

  if (!parsed.success) {
    return c.json(
      { error: { code: 'VALIDATION_ERROR', message: 'Invalid input', details: parsed.error.flatten() } },
      400,
    );
  }

  const {
    workflowTemplateId,
    projectId,
    agentDefinitionId,
    description,
    title,
    baseBranch,
    targetBranch,
    model,
    credentialSetId,
  } = parsed.data;

  const db = getDb();

  // Validate references exist
  const template = db
    .select({ id: schema.workflowTemplates.id })
    .from(schema.workflowTemplates)
    .where(eq(schema.workflowTemplates.id, workflowTemplateId))
    .get();
  if (!template) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Workflow template not found' } }, 404);
  }

  const project = db
    .select({ id: schema.projects.id })
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId))
    .get();
  if (!project) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Project not found' } }, 404);
  }

  const agent = db
    .select({ id: schema.agentDefinitions.id })
    .from(schema.agentDefinitions)
    .where(eq(schema.agentDefinitions.id, agentDefinitionId))
    .get();
  if (!agent) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Agent definition not found' } }, 404);
  }

  // Create the workflow run record
  const runId = crypto.randomUUID();
  db.insert(schema.workflowRuns)
    .values({
      id: runId,
      workflowTemplateId,
      projectId,
      agentDefinitionId,
      description: description ?? null,
      title: title ?? null,
      status: 'pending',
      baseBranch,
      targetBranch: targetBranch ?? baseBranch,
      model: model ?? null,
      credentialSetId: credentialSetId ?? null,
    })
    .run();

  // Save as last-run config (singleton)
  db.insert(schema.lastRunConfig)
    .values({
      id: 1,
      projectId,
      agentDefinitionId,
      credentialSetId: credentialSetId ?? null,
      workflowTemplateId,
    })
    .onConflictDoUpdate({
      target: schema.lastRunConfig.id,
      set: {
        projectId,
        agentDefinitionId,
        credentialSetId: credentialSetId ?? null,
        workflowTemplateId,
        updatedAt: new Date().toISOString(),
      },
    })
    .run();

  // Start the durable workflow (only serializable data in input)
  try {
    await start(runWorkflowPipeline, [{ runId }]);
  } catch (err) {
    logger.error({ err, runId }, 'Failed to start workflow pipeline');
    db.update(schema.workflowRuns)
      .set({ status: 'failed' })
      .where(eq(schema.workflowRuns.id, runId))
      .run();
    return c.json({ error: { code: 'WORKFLOW_START_ERROR', message: 'Failed to start workflow' } }, 500);
  }

  logger.info({ runId, workflowTemplateId, projectId }, 'Workflow run created and started');

  const created = db
    .select()
    .from(schema.workflowRuns)
    .where(eq(schema.workflowRuns.id, runId))
    .get();

  return c.json(created, 201);
});

// ── GET /api/runs — List workflow runs ───────────────────────────────

runs.get('/api/runs', (c) => {
  const db = getDb();
  const statusFilter = c.req.query('status');
  const projectFilter = c.req.query('projectId');

  let query = db.select().from(schema.workflowRuns).orderBy(desc(schema.workflowRuns.createdAt));

  // Apply filters if provided (using .where chaining)
  const allRuns = query.all().filter((r) => {
    if (statusFilter && r.status !== statusFilter) return false;
    if (projectFilter && r.projectId !== projectFilter) return false;
    return true;
  });

  return c.json({ runs: allRuns });
});

// ── GET /api/runs/:id — Run detail with stage executions ────────────

runs.get('/api/runs/:id', (c) => {
  const db = getDb();
  const runId = c.req.param('id');

  const run = db
    .select()
    .from(schema.workflowRuns)
    .where(eq(schema.workflowRuns.id, runId))
    .get();

  if (!run) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Workflow run not found' } }, 404);
  }

  const stages = db
    .select()
    .from(schema.stageExecutions)
    .where(eq(schema.stageExecutions.workflowRunId, runId))
    .all();

  const reviews = db
    .select()
    .from(schema.reviews)
    .where(eq(schema.reviews.workflowRunId, runId))
    .all();

  return c.json({ ...run, stages, reviews });
});

// ── GET /api/runs/:id/messages — Run conversation messages ──────────

runs.get('/api/runs/:id/messages', (c) => {
  const db = getDb();
  const runId = c.req.param('id');

  const messages = db
    .select()
    .from(schema.runMessages)
    .where(eq(schema.runMessages.workflowRunId, runId))
    .orderBy(schema.runMessages.createdAt)
    .all();

  return c.json({ messages });
});

// ── PATCH /api/runs/:id/cancel — Cancel a running workflow ──────────

runs.patch('/api/runs/:id/cancel', async (c) => {
  const db = getDb();
  const runId = c.req.param('id');

  const run = db
    .select({
      status: schema.workflowRuns.status,
      currentStage: schema.workflowRuns.currentStage,
    })
    .from(schema.workflowRuns)
    .where(eq(schema.workflowRuns.id, runId))
    .get();

  if (!run) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Workflow run not found' } }, 404);
  }

  if (['completed', 'failed', 'cancelled'].includes(run.status)) {
    return c.json(
      { error: { code: 'CONFLICT', message: `Run is already in terminal state: ${run.status}` } },
      409,
    );
  }

  // Resume any suspended hooks so the pipeline can exit cleanly
  try {
    switch (run.status) {
      case 'stage_failed': {
        const hookToken = `failed:${runId}:${run.currentStage}`;
        await stageFailedHook.resume(hookToken, { action: 'cancel' });
        break;
      }
      case 'awaiting_review': {
        // Find the pending review for this run to build the hook token
        const pendingReview = db.select({ id: schema.reviews.id })
          .from(schema.reviews)
          .where(and(
            eq(schema.reviews.workflowRunId, runId),
            eq(schema.reviews.status, 'pending_review'),
          ))
          .orderBy(desc(schema.reviews.createdAt))
          .limit(1)
          .get();
        if (pendingReview) {
          const hookToken = `review:${pendingReview.id}`;
          await reviewDecisionHook.resume(hookToken, { action: 'cancel' });
        }
        break;
      }
      case 'awaiting_conflict_resolution': {
        const hookToken = `conflict:${runId}:finalize`;
        await conflictResolutionHook.resume(hookToken, { action: 'cancel' });
        break;
      }
      case 'awaiting_proposals': {
        const hookToken = `proposals:${runId}:${run.currentStage}`;
        await proposalReviewHook.resume(hookToken, { proposalIds: [] });
        break;
      }
    }
  } catch (err) {
    logger.warn({ err, runId, status: run.status }, 'Failed to resume hook during cancel (best-effort)');
  }

  // Stop the session (best-effort)
  try {
    const deps = getDeps();
    await deps.sessionManager.stop(runId);
  } catch {
    // Session may not be active
  }

  db.update(schema.workflowRuns)
    .set({ status: 'cancelled', completedAt: new Date().toISOString() })
    .where(eq(schema.workflowRuns.id, runId))
    .run();

  logger.info({ runId }, 'Workflow run cancelled');
  return c.json({ status: 'cancelled' });
});

// ── POST /api/runs/:id/retry-stage — Resume stageFailedHook (retry) ─

runs.post('/api/runs/:id/retry-stage', async (c) => {
  const runId = c.req.param('id');
  return resumeStageHook(c, runId, { action: 'retry' as const });
});

// ── POST /api/runs/:id/skip-stage — Resume stageFailedHook (skip) ───

runs.post('/api/runs/:id/skip-stage', async (c) => {
  const runId = c.req.param('id');
  return resumeStageHook(c, runId, { action: 'skip' as const });
});

// ── POST /api/runs/:id/message — Send user intervention ─────────────

const messageSchema = z.object({
  message: z.string().min(1),
});

runs.post('/api/runs/:id/message', async (c) => {
  const runId = c.req.param('id');
  const body = await c.req.json();
  const parsed = messageSchema.safeParse(body);

  if (!parsed.success) {
    return c.json(
      { error: { code: 'VALIDATION_ERROR', message: 'Invalid input' } },
      400,
    );
  }

  const db = getDb();
  const run = db
    .select({
      status: schema.workflowRuns.status,
      currentStage: schema.workflowRuns.currentStage,
    })
    .from(schema.workflowRuns)
    .where(eq(schema.workflowRuns.id, runId))
    .get();

  if (!run) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Workflow run not found' } }, 404);
  }

  if (run.status !== 'running') {
    return c.json(
      { error: { code: 'CONFLICT', message: 'Can only send messages to running workflows' } },
      409,
    );
  }

  // Resolve current round from latest stageExecution
  const latestStage = db.select({ round: schema.stageExecutions.round })
    .from(schema.stageExecutions)
    .where(and(
      eq(schema.stageExecutions.workflowRunId, runId),
      eq(schema.stageExecutions.stageName, run.currentStage ?? ''),
    ))
    .orderBy(desc(schema.stageExecutions.round))
    .limit(1)
    .get();

  try {
    const deps = getDeps();
    await deps.sessionManager.sendIntervention(runId, parsed.data.message);

    // Record the intervention in runMessages
    db.insert(schema.runMessages)
      .values({
        workflowRunId: runId,
        stageName: run.currentStage ?? 'unknown',
        round: latestStage?.round ?? 1,
        role: 'user',
        content: parsed.data.message,
        isIntervention: true,
      })
      .run();

    return c.json({ status: 'sent' });
  } catch (err) {
    return c.json(
      { error: { code: 'INTERVENTION_FAILED', message: 'Failed to send message' } },
      500,
    );
  }
});

// ── Helper: resume stage failed hook via outbox pattern ──────────────

async function resumeStageHook(
  c: any,
  runId: string,
  payload: { action: 'retry' } | { action: 'skip' },
) {
  const db = getDb();
  const run = db
    .select({ status: schema.workflowRuns.status, currentStage: schema.workflowRuns.currentStage })
    .from(schema.workflowRuns)
    .where(eq(schema.workflowRuns.id, runId))
    .get();

  if (!run) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Workflow run not found' } }, 404);
  }

  if (run.status !== 'stage_failed') {
    return c.json(
      { error: { code: 'CONFLICT', message: `Run is not in stage_failed state (current: ${run.status})` } },
      409,
    );
  }

  // Find the hook token — stable format: `failed:{runId}:{stageName}`
  try {
    // Write to outbox first for crash safety
    const outboxId = crypto.randomUUID();
    const hookToken = `failed:${runId}:${run.currentStage}`;

    db.insert(schema.hookResumes)
      .values({
        id: outboxId,
        hookToken,
        action: JSON.stringify(payload),
      })
      .run();

    // Resume the hook
    await stageFailedHook.resume(hookToken, payload);

    // Delete from outbox on success
    db.delete(schema.hookResumes)
      .where(eq(schema.hookResumes.id, outboxId))
      .run();

    logger.info({ runId, action: payload.action }, 'Stage failed hook resumed');
    return c.json({ status: 'resumed', action: payload.action });
  } catch (err) {
    logger.error({ err, runId }, 'Failed to resume stage hook');
    return c.json(
      { error: { code: 'HOOK_RESUME_ERROR', message: 'Failed to resume hook' } },
      500,
    );
  }
}

// ── GET /api/runs/:id/result — Run result with commit info ──────────

function parseNameStatus(output: string): Array<{ status: string; path: string }> {
  return output
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [code, ...pathParts] = line.split('\t');
      const status =
        code === 'A' ? 'added'
        : code === 'D' ? 'deleted'
        : code?.startsWith('R') ? 'renamed'
        : 'modified';
      return { status, path: pathParts.join('\t') };
    });
}

runs.get('/api/runs/:id/result', (c) => {
  const db = getDb();
  const runId = c.req.param('id');

  const run = db
    .select()
    .from(schema.workflowRuns)
    .where(eq(schema.workflowRuns.id, runId))
    .get();

  if (!run) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Workflow run not found' } }, 404);
  }

  const gitOp = db
    .select()
    .from(schema.gitOperations)
    .where(
      and(
        eq(schema.gitOperations.workflowRunId, runId),
        eq(schema.gitOperations.type, 'finalize'),
      ),
    )
    .get();

  const metadata: Record<string, any> = gitOp?.metadata ? JSON.parse(gitOp.metadata) : {};

  let filesChanged: Array<{ status: string; path: string }> = [];
  let diffStat: string | null = null;

  if (metadata.commitHash) {
    const project = db
      .select({ localPath: schema.projects.localPath })
      .from(schema.projects)
      .where(eq(schema.projects.id, run.projectId))
      .get();

    if (project?.localPath) {
      try {
        const nameStatusOut = execFileSync(
          'git',
          ['diff', '--name-status', `${metadata.commitHash}~1..${metadata.commitHash}`],
          { cwd: project.localPath, encoding: 'utf-8', timeout: 5000 },
        );
        filesChanged = parseNameStatus(nameStatusOut);

        const statOut = execFileSync(
          'git',
          ['diff', '--stat', `${metadata.commitHash}~1..${metadata.commitHash}`],
          { cwd: project.localPath, encoding: 'utf-8', timeout: 5000 },
        );
        diffStat = statOut.trim();
      } catch {
        // git not available or commit not found — return metadata only
      }
    }
  }

  return c.json({
    commitHash: metadata.commitHash ?? null,
    commitMessage: metadata.commitMessage ?? null,
    branch: metadata.branch ?? run.branch,
    targetBranch: metadata.targetBranch ?? run.targetBranch,
    completedAt: run.completedAt,
    filesChanged,
    diffStat,
  });
});

export { runs };
