// ---------------------------------------------------------------------------
// Pipeline DB Step Functions
//
// Wraps all database operations used by pipeline.ts behind the "use step"
// boundary. The "use workflow" module cannot import Node.js modules (drizzle,
// better-sqlite3), but "use step" modules can.
// ---------------------------------------------------------------------------
"use step";

import { getDb } from '../../db/index.js';
import * as schema from '../../db/schema.js';
import { eq, and, desc } from 'drizzle-orm';
import { logger } from '../../lib/logger.js';
import { resolveSandboxResources } from '../../lib/sandbox-resources.js';

// ── Types (shared with pipeline.ts) ────────────────────────────────────────

export interface PipelineContext {
  runId: string;
  projectId: string;
  agentDefinitionId: string;
  description: string;
  baseBranch: string;
  targetBranch: string;
  credentialSetId: string | null;
  ghAccount: string | null;
  stages: WorkflowStage[];
}

export interface WorkflowStage {
  name: string;
  splittable?: boolean;
  promptTemplate: string;
  reviewRequired: boolean;
  autoAdvance: boolean;
  freshSession: boolean;
  model?: string;
  isFinal?: boolean;
}

export interface RunRecord {
  id: string;
  status: string;
  branch: string | null;
  model: string | null;
  workflowTemplateId: string;
  projectId: string;
  agentDefinitionId: string;
  description: string | null;
  baseBranch: string | null;
  targetBranch: string | null;
  credentialSetId: string | null;
  title: string | null;
}

export interface AgentDefResult {
  commandTemplate: string;
  dockerImage?: string;
}

// ── Context loading ────────────────────────────────────────────────────────

export async function loadPipelineContext(runId: string): Promise<PipelineContext> {
  const log = logger.child({ runId, op: 'loadPipelineContext' });
  const db = getDb();

  const run = db
    .select()
    .from(schema.workflowRuns)
    .where(eq(schema.workflowRuns.id, runId))
    .get();

  if (!run) throw new Error(`Workflow run ${runId} not found`);

  const template = db
    .select()
    .from(schema.workflowTemplates)
    .where(eq(schema.workflowTemplates.id, run.workflowTemplateId))
    .get();

  if (!template) throw new Error(`Workflow template ${run.workflowTemplateId} not found`);

  const stages: WorkflowStage[] = JSON.parse(template.stages);

  log.info(
    {
      projectId: run.projectId,
      agentDefinitionId: run.agentDefinitionId,
      templateId: run.workflowTemplateId,
      stageCount: stages.length,
      stageNames: stages.map(s => s.name),
      baseBranch: run.baseBranch,
    },
    'Pipeline context loaded',
  );

  // Resolve ghAccount: run-level → project-level → global settings default
  let ghAccount: string | null = run.ghAccount ?? null;
  if (!ghAccount) {
    const project = db
      .select({ ghAccount: schema.projects.ghAccount })
      .from(schema.projects)
      .where(eq(schema.projects.id, run.projectId))
      .get();
    ghAccount = project?.ghAccount ?? null;
  }
  if (!ghAccount) {
    const setting = db
      .select({ value: schema.settings.value })
      .from(schema.settings)
      .where(eq(schema.settings.key, 'defaultGhAccount'))
      .get();
    ghAccount = setting?.value ?? null;
  }

  return {
    runId,
    projectId: run.projectId,
    agentDefinitionId: run.agentDefinitionId,
    description: run.description ?? '',
    baseBranch: run.baseBranch ?? 'main',
    targetBranch: run.targetBranch ?? run.baseBranch ?? 'main',
    credentialSetId: run.credentialSetId,
    ghAccount,
    stages,
  };
}

// ── Run record queries ─────────────────────────────────────────────────────

export async function getRunRecord(runId: string): Promise<RunRecord | undefined> {
  const db = getDb();
  return db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get() as RunRecord | undefined;
}

export async function getRunModel(runId: string): Promise<string | null> {
  const db = getDb();
  const run = db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get();
  return run?.model ?? null;
}

export async function getProject(projectId: string): Promise<{ id: string; localPath: string } | undefined> {
  const db = getDb();
  return db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get() as { id: string; localPath: string } | undefined;
}

export async function getAgentDef(agentDefinitionId: string): Promise<AgentDefResult> {
  const db = getDb();
  const agent = db
    .select()
    .from(schema.agentDefinitions)
    .where(eq(schema.agentDefinitions.id, agentDefinitionId))
    .get();
  if (!agent) throw new Error(`Agent definition ${agentDefinitionId} not found`);
  return {
    commandTemplate: agent.commandTemplate,
    dockerImage: agent.dockerImage ?? undefined,
  };
}

// ── Status updates ─────────────────────────────────────────────────────────

export async function updateRunStatus(runId: string, status: string): Promise<void> {
  const db = getDb();
  db.update(schema.workflowRuns)
    .set({ status })
    .where(eq(schema.workflowRuns.id, runId))
    .run();
}

export async function getRunStatus(runId: string): Promise<string | null> {
  const db = getDb();
  const row = db
    .select({ status: schema.workflowRuns.status })
    .from(schema.workflowRuns)
    .where(eq(schema.workflowRuns.id, runId))
    .get();
  return row?.status ?? null;
}

export async function updateCurrentStage(runId: string, stageName: string): Promise<void> {
  const db = getDb();
  db.update(schema.workflowRuns)
    .set({ currentStage: stageName })
    .where(eq(schema.workflowRuns.id, runId))
    .run();
}

export async function updateReviewStatus(reviewId: string, status: string): Promise<void> {
  const db = getDb();
  db.update(schema.reviews)
    .set({ status })
    .where(eq(schema.reviews.id, reviewId))
    .run();
}

// ── Split config snapshot helpers (rubber-duck blocker #1) ─────────────
//
// The split snapshot is written ONCE at the moment the user clicks Split
// in a review, and is also embedded in the review hook resume payload.
// The persistence here is for crash-recovery and audit; the workflow
// reads from the hook payload. We expose a getter for tooling/UX that
// needs to display the snapshot (e.g. listing skipped stages).

export async function persistSplitConfig(runId: string, snapshot: unknown): Promise<void> {
  const db = getDb();
  // Best-effort idempotency: only write if not already set. The route is
  // already gated by run-not-already-split, but this defends against races.
  const existing = db.select({ s: schema.workflowRuns.splitConfigJson })
    .from(schema.workflowRuns)
    .where(eq(schema.workflowRuns.id, runId))
    .get();
  if (existing?.s) return;
  db.update(schema.workflowRuns)
    .set({ splitConfigJson: JSON.stringify(snapshot) })
    .where(eq(schema.workflowRuns.id, runId))
    .run();
}

export async function getSplitConfig(runId: string): Promise<unknown | null> {
  const db = getDb();
  const row = db.select({ s: schema.workflowRuns.splitConfigJson })
    .from(schema.workflowRuns)
    .where(eq(schema.workflowRuns.id, runId))
    .get();
  if (!row?.s) return null;
  try { return JSON.parse(row.s); } catch { return null; }
}

/**
 * Clear a previously-persisted split snapshot. Used by the split route to
 * recover from a failed hook resume so the user can retry without hitting
 * the "already split" guard (rubber-duck C2).
 */
export async function clearSplitConfig(runId: string): Promise<void> {
  const db = getDb();
  db.update(schema.workflowRuns)
    .set({ splitConfigJson: null })
    .where(eq(schema.workflowRuns.id, runId))
    .run();
}

// ── Stage execution queries ────────────────────────────────────────────────

export async function getCurrentRound(runId: string, stageName: string): Promise<number> {
  const db = getDb();
  const exec = db
    .select({ round: schema.stageExecutions.round })
    .from(schema.stageExecutions)
    .where(
      and(
        eq(schema.stageExecutions.workflowRunId, runId),
        eq(schema.stageExecutions.stageName, stageName),
      ),
    )
    .orderBy(desc(schema.stageExecutions.round))
    .limit(1)
    .get();
  return exec?.round ?? 0;
}

export async function markStageSkipped(runId: string, stageName: string): Promise<void> {
  const db = getDb();
  const exec = db
    .select({ round: schema.stageExecutions.round })
    .from(schema.stageExecutions)
    .where(
      and(
        eq(schema.stageExecutions.workflowRunId, runId),
        eq(schema.stageExecutions.stageName, stageName),
      ),
    )
    .orderBy(desc(schema.stageExecutions.round))
    .limit(1)
    .get();
  const currentRound = exec?.round ?? 0;

  db.update(schema.stageExecutions)
    .set({ status: 'skipped' })
    .where(
      and(
        eq(schema.stageExecutions.workflowRunId, runId),
        eq(schema.stageExecutions.stageName, stageName),
        eq(schema.stageExecutions.round, currentRound),
      ),
    )
    .run();
}

// ── Child run helpers ──────────────────────────────────────────────────────

export async function getChildStatuses(childRunIds: string[]): Promise<string[]> {
  const db = getDb();
  return childRunIds.map((id) => {
    const run = db
      .select({ status: schema.workflowRuns.status })
      .from(schema.workflowRuns)
      .where(eq(schema.workflowRuns.id, id))
      .get();
    return run?.status ?? 'unknown';
  });
}

export async function getChildTitles(childRunIds: string[]): Promise<string[]> {
  const db = getDb();
  return childRunIds.map((id) => {
    const run = db
      .select({ title: schema.workflowRuns.title })
      .from(schema.workflowRuns)
      .where(eq(schema.workflowRuns.id, id))
      .get();
    return run?.title ?? id.slice(0, 8);
  });
}

export async function retryChildWorkflowRun(childRunId: string): Promise<void> {
  const db = getDb();
  db.update(schema.workflowRuns)
    .set({ status: 'pending', completedAt: null })
    .where(eq(schema.workflowRuns.id, childRunId))
    .run();

  // Dynamic import to avoid circular dependency with pipeline.ts
  const { start } = await import('workflow/api');
  const { runWorkflowPipeline } = await import('../pipeline.js');
  start(runWorkflowPipeline, [{ runId: childRunId }]);
}

export async function cancelAllChildRuns(childRunIds: string[]): Promise<void> {
  const db = getDb();
  for (const id of childRunIds) {
    const run = db
      .select({ status: schema.workflowRuns.status })
      .from(schema.workflowRuns)
      .where(eq(schema.workflowRuns.id, id))
      .get();

    if (run && !['completed', 'failed', 'cancelled'].includes(run.status)) {
      db.update(schema.workflowRuns)
        .set({ status: 'cancelled', completedAt: new Date().toISOString() })
        .where(eq(schema.workflowRuns.id, id))
        .run();
    }
  }
}

// ── Session management steps ───────────────────────────────────────────────

const DEPS_KEY = '__vibe_pipeline_deps__';

export async function provisionSession(input: {
  runId: string;
  projectId: string;
  agentDefinitionId: string;
  baseBranch: string;
  model?: string;
  ghAccount?: string | null;
}): Promise<void> {
  const log = logger.child({ runId: input.runId, op: 'provisionSession' });
  log.info(
    {
      projectId: input.projectId,
      agentDefinitionId: input.agentDefinitionId,
      baseBranch: input.baseBranch,
      model: input.model,
    },
    'Provisioning session',
  );

  const deps = (globalThis as any)[DEPS_KEY];
  if (!deps?.sessionManager) {
    log.warn('No sessionManager in global deps, skipping provision');
    return;
  }

  const db = getDb();
  const run = db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, input.runId)).get();
  if (!run) {
    log.warn('Run not found, skipping provision');
    return;
  }

  if (deps.sessionManager.isActive(input.runId)) {
    log.info('Session already active, skipping provision');
    return;
  }

  const project = db.select().from(schema.projects).where(eq(schema.projects.id, input.projectId)).get();
  if (!project) {
    log.warn({ projectId: input.projectId }, 'Project not found, skipping provision');
    return;
  }

  const agent = db.select().from(schema.agentDefinitions).where(eq(schema.agentDefinitions.id, input.agentDefinitionId)).get();
  if (!agent) throw new Error(`Agent definition ${input.agentDefinitionId} not found`);

  // Resolve sbx VM resources: per-run override > project default > omit
  const resolvedResources = resolveSandboxResources(
    { sandboxMemory: project.sandboxMemory, sandboxCpus: project.sandboxCpus },
    { sandboxMemory: run.sandboxMemory, sandboxCpus: run.sandboxCpus },
  );

  log.info(
    {
      projectPath: project.localPath,
      branchName: run.branch,
      agentCommand: agent.commandTemplate,
      sandboxMemory: resolvedResources.memory,
      sandboxCpus: resolvedResources.cpus,
    },
    'Calling sessionManager.create',
  );

  await deps.sessionManager.create(input.runId, {
    model: input.model,
    projectPath: project.localPath,
    branchName: run.branch ?? `vibe-harness/run-${input.runId.slice(0, 8)}`,
    baseBranch: input.baseBranch,
    agentDef: {
      commandTemplate: agent.commandTemplate,
      dockerImage: agent.dockerImage ?? undefined,
    },
    ghAccount: input.ghAccount,
    sandboxMemory: resolvedResources.memory,
    sandboxCpus: resolvedResources.cpus,
  });

  log.info('Session provisioned successfully');
}

export async function stopSession(input: { runId: string }): Promise<void> {
  const log = logger.child({ runId: input.runId, op: 'stopSession' });
  log.info('Stopping session');
  const deps = (globalThis as any)[DEPS_KEY];
  if (!deps?.sessionManager) {
    log.warn('No sessionManager in global deps, skipping stop');
    return;
  }
  await deps.sessionManager.stop(input.runId);
  log.info('Session stopped');
}

/** Resolve pipeline deps from globalThis (set at daemon startup). */
export async function getGlobalDeps(): Promise<any> {
  throw new Error('getGlobalDeps() is deprecated — steps should use resolveGlobalDeps() internally.');
}
