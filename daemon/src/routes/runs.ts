// ---------------------------------------------------------------------------
// Workflow Runs API Routes (CDD-workflow §6)
//
// Manages workflow run lifecycle: create, list, detail, cancel, retry, skip,
// and message (intervention). Hooks into the durable workflow engine.
// ---------------------------------------------------------------------------

import { Hono } from 'hono';
import { eq, and, desc, inArray } from 'drizzle-orm';
import { start, resumeHook } from 'workflow/api';
import { execFileSync } from 'node:child_process';
import { getDb } from '../db/index.js';
import * as schema from '../db/schema.js';
import { logger } from '../lib/logger.js';
import { dockerImageExists } from '../lib/docker-image.js';
import { runWorkflowPipeline, type PipelineDeps } from '../workflows/pipeline.js';
import { setPipelineDeps as setPipelineDepsInternal } from '../workflows/pipeline-deps.js';
import {
  stageFailedHook,
  reviewDecisionHook,
  conflictResolutionHook,
  proposalReviewHook,
  parallelCompletionHook,
} from '../workflows/hooks.js';
import {
  stageFailedToken,
  reviewToken,
  proposalsToken,
  parallelToken,
  finalizeConflictToken,
  consolidateConflictToken,
} from '../workflows/hookTokens.js';
import { z } from 'zod';
import { sandboxMemorySchema, sandboxCpusSchema } from '../lib/validation/shared.js';
import { serializeRunSandboxFields } from '../lib/sandbox-resources.js';

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
  ghAccount: z.string().max(100).optional(),
  // sandboxMemory / sandboxCpus follow tri-state semantics:
  //   undefined → inherit project default
  //   null      → explicit override: omit the flag (use sbx default)
  //   value     → use this value
  sandboxMemory: sandboxMemorySchema.nullable().optional(),
  sandboxCpus: sandboxCpusSchema.nullable().optional(),
  attachments: z
    .array(
      z.object({
        name: z.string(),
        type: z.string(),
        dataUrl: z.string(),
      }),
    )
    .optional(),
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
    ghAccount,
    sandboxMemory,
    sandboxCpus,
    attachments,
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
    .select({ id: schema.agentDefinitions.id, dockerImage: schema.agentDefinitions.dockerImage, name: schema.agentDefinitions.name })
    .from(schema.agentDefinitions)
    .where(eq(schema.agentDefinitions.id, agentDefinitionId))
    .get();
  if (!agent) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Agent definition not found' } }, 404);
  }

  // Pre-flight: when the agent specifies a custom Docker image, the image must
  // be built locally before the run is allowed to start. Without this check,
  // `sbx create --template <missing>` would fail mid-provisioning with a
  // confusing 401 from Docker Hub. We surface a structured error so the GUI
  // can guide the user to the build screen instead.
  if (agent.dockerImage && !dockerImageExists(agent.dockerImage)) {
    return c.json(
      {
        error: {
          code: 'AGENT_IMAGE_MISSING',
          message: `Docker image '${agent.dockerImage}' for agent '${agent.name}' is not built. Build it before starting a run.`,
          agentDefinitionId: agent.id,
          agentName: agent.name,
          image: agent.dockerImage,
        },
      },
      409,
    );
  }

  // Resolve tri-state for persistence:
  //   - if caller passed `sandboxMemory: null` (explicit override → use sbx default),
  //     persist the sentinel "" (empty string) so we can distinguish from "inherit project".
  //   - if caller omitted, persist null (= inherit project at run time).
  //   - if caller passed a value, persist it.
  // Same for sandboxCpus, with -1 as the "explicit override → sbx default" sentinel.
  const memoryToPersist =
    sandboxMemory === undefined ? null : sandboxMemory === null ? '' : sandboxMemory;
  const cpusToPersist =
    sandboxCpus === undefined ? null : sandboxCpus === null ? -1 : sandboxCpus;

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
      ghAccount: ghAccount ?? null,
      sandboxMemory: memoryToPersist,
      sandboxCpus: cpusToPersist,
      attachments: attachments?.length ? JSON.stringify(attachments) : null,
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

  return c.json(created ? serializeRunSandboxFields(created) : created, 201);
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

  return c.json({ runs: allRuns.map(serializeRunSandboxFields) });
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

  // Derive activeReviewId from pending reviews
  const activeReview = reviews.find((r) => r.status === 'pending_review');

  return c.json({ ...serializeRunSandboxFields(run), stages, reviews, activeReviewId: activeReview?.id ?? null });
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
        const hookToken = stageFailedToken(runId, run.currentStage ?? '');
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
          const hookToken = reviewToken(pendingReview.id);
          await reviewDecisionHook.resume(hookToken, { action: 'cancel' });
        }
        break;
      }
      case 'awaiting_conflict_resolution': {
        // Disambiguate: consolidation conflict has an active parallel group
        // whose sourceWorkflowRunId is this run; finalize conflict does not.
        const activeGroup = db
          .select({ id: schema.parallelGroups.id })
          .from(schema.parallelGroups)
          .where(and(
            eq(schema.parallelGroups.sourceWorkflowRunId, runId),
            inArray(schema.parallelGroups.status, ['running', 'consolidating', 'children_mixed', 'children_completed']),
          ))
          .limit(1)
          .get();
        const hookToken = activeGroup
          ? consolidateConflictToken(runId, activeGroup.id)
          : finalizeConflictToken(runId);
        await conflictResolutionHook.resume(hookToken, { action: 'cancel' });
        break;
      }
      case 'awaiting_proposals': {
        const hookToken = proposalsToken(runId);
        await proposalReviewHook.resume(hookToken, { proposalIds: [] });
        break;
      }
      case 'children_completed_with_failures': {
        const hookToken = parallelToken(runId);
        await parallelCompletionHook.resume(hookToken, { action: 'cancel' });
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

  // Find the hook token via shared helper.
  try {
    // Write to outbox first for crash safety
    const outboxId = crypto.randomUUID();
    const hookToken = stageFailedToken(runId, run.currentStage ?? '');

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

// ── GET /api/runs/:id/result/diff — Full unified diff for commit ────

runs.get('/api/runs/:id/result/diff', (c) => {
  const db = getDb();
  const runId = c.req.param('id');

  const run = db.select().from(schema.workflowRuns)
    .where(eq(schema.workflowRuns.id, runId)).get();
  if (!run) return c.json({ error: { code: 'NOT_FOUND' } }, 404);

  const gitOp = db.select().from(schema.gitOperations)
    .where(and(
      eq(schema.gitOperations.workflowRunId, runId),
      eq(schema.gitOperations.type, 'finalize'),
    )).get();

  const metadata = gitOp?.metadata ? JSON.parse(gitOp.metadata) : {};
  if (!metadata.commitHash) return c.json({ diff: null });

  const project = db.select({ localPath: schema.projects.localPath })
    .from(schema.projects)
    .where(eq(schema.projects.id, run.projectId)).get();

  if (!project?.localPath) return c.json({ diff: null });

  try {
    const diff = execFileSync('git',
      ['diff', `${metadata.commitHash}~1..${metadata.commitHash}`],
      { cwd: project.localPath, encoding: 'utf-8', timeout: 10000 },
    );
    return c.json({ diff });
  } catch {
    return c.json({ diff: null });
  }
});

export { runs };

// ── DELETE /api/runs/:id — Delete a terminal-state run and its descendants ──

const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled', 'stage_failed', 'children_completed_with_failures'];

runs.delete('/api/runs/:id', (c) => {
  const db = getDb();
  const runId = c.req.param('id');
  const log = logger.child({ runId, op: 'deleteRun' });

  const run = db
    .select()
    .from(schema.workflowRuns)
    .where(eq(schema.workflowRuns.id, runId))
    .get();

  if (!run) {
    return c.json(
      { error: { code: 'NOT_FOUND', message: 'Workflow run not found' } },
      404,
    );
  }

  if (!TERMINAL_STATUSES.includes(run.status)) {
    return c.json(
      { error: { code: 'RUN_ACTIVE', message: `Cannot delete run in '${run.status}' state` } },
      409,
    );
  }

  // Collect all run IDs to delete (the run + all descendants via parentRunId)
  const allRunIds: string[] = [];
  const queue = [runId];
  while (queue.length > 0) {
    const currentId = queue.pop()!;
    allRunIds.push(currentId);
    const children = db
      .select({ id: schema.workflowRuns.id })
      .from(schema.workflowRuns)
      .where(eq(schema.workflowRuns.parentRunId, currentId))
      .all();
    for (const child of children) {
      queue.push(child.id);
    }
  }

  log.info({ runCount: allRunIds.length }, 'Deleting run tree');

  // Collect review IDs for cascade to reviewComments
  const reviewIds = db
    .select({ id: schema.reviews.id })
    .from(schema.reviews)
    .where(inArray(schema.reviews.workflowRunId, allRunIds))
    .all()
    .map((r) => r.id);

  // Delete in FK-safe order (all within a single transaction)
  db.transaction((tx) => {
    if (reviewIds.length > 0) {
      tx.delete(schema.reviewComments)
        .where(inArray(schema.reviewComments.reviewId, reviewIds))
        .run();
    }

    tx.delete(schema.reviews)
      .where(inArray(schema.reviews.workflowRunId, allRunIds))
      .run();

    tx.delete(schema.stageExecutions)
      .where(inArray(schema.stageExecutions.workflowRunId, allRunIds))
      .run();

    tx.delete(schema.gitOperations)
      .where(inArray(schema.gitOperations.workflowRunId, allRunIds))
      .run();

    // Nullify proposal references to runs being deleted
    for (const id of allRunIds) {
      tx.update(schema.proposals)
        .set({ launchedWorkflowRunId: null })
        .where(eq(schema.proposals.launchedWorkflowRunId, id))
        .run();
    }

    // Delete proposals belonging to these runs (cascade handles runMessages)
    tx.delete(schema.proposals)
      .where(inArray(schema.proposals.workflowRunId, allRunIds))
      .run();

    // Nullify audit log references (don't delete audit records)
    for (const id of allRunIds) {
      tx.update(schema.credentialAuditLog)
        .set({ workflowRunId: null })
        .where(eq(schema.credentialAuditLog.workflowRunId, id))
        .run();
    }

    // Clean up parallel groups sourced from these runs
    tx.delete(schema.parallelGroups)
      .where(inArray(schema.parallelGroups.sourceWorkflowRunId, allRunIds))
      .run();

    // Delete runs (children first via reversed order since queue is BFS)
    for (const id of allRunIds.reverse()) {
      tx.delete(schema.workflowRuns)
        .where(eq(schema.workflowRuns.id, id))
        .run();
    }
  });

  log.info('Run tree deleted');
  return c.body(null, 204);
});
