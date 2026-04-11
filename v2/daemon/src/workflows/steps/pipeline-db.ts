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

// ── Types (shared with pipeline.ts) ────────────────────────────────────────

export interface PipelineContext {
  runId: string;
  projectId: string;
  agentDefinitionId: string;
  description: string;
  baseBranch: string;
  targetBranch: string;
  credentialSetId: string | null;
  stages: WorkflowStage[];
}

export interface WorkflowStage {
  name: string;
  type: 'standard' | 'split';
  promptTemplate: string;
  reviewRequired: boolean;
  autoAdvance: boolean;
  freshSession: boolean;
  model?: string;
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

  return {
    runId,
    projectId: run.projectId,
    agentDefinitionId: run.agentDefinitionId,
    description: run.description ?? '',
    baseBranch: run.baseBranch ?? 'main',
    targetBranch: run.targetBranch ?? run.baseBranch ?? 'main',
    credentialSetId: run.credentialSetId,
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
}): Promise<void> {
  const deps = (globalThis as any)[DEPS_KEY];
  if (!deps?.sessionManager) return;

  const db = getDb();
  const run = db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, input.runId)).get();
  if (!run) return;

  if (deps.sessionManager.isActive(input.runId)) return;

  const project = db.select().from(schema.projects).where(eq(schema.projects.id, input.projectId)).get();
  if (!project) return;

  const agent = db.select().from(schema.agentDefinitions).where(eq(schema.agentDefinitions.id, input.agentDefinitionId)).get();
  if (!agent) throw new Error(`Agent definition ${input.agentDefinitionId} not found`);

  await deps.sessionManager.create(input.runId, {
    model: input.model,
    projectPath: project.localPath,
    branchName: run.branch ?? `vibe-harness/run-${input.runId.slice(0, 8)}`,
    baseBranch: input.baseBranch,
    agentDef: {
      commandTemplate: agent.commandTemplate,
      dockerImage: agent.dockerImage ?? undefined,
    },
  });
}

export async function stopSession(input: { runId: string }): Promise<void> {
  const deps = (globalThis as any)[DEPS_KEY];
  if (!deps?.sessionManager) return;
  await deps.sessionManager.stop(input.runId);
}

/** Resolve pipeline deps from globalThis (set at daemon startup). */
export async function getGlobalDeps(): Promise<any> {
  throw new Error('getGlobalDeps() is deprecated — steps should use resolveGlobalDeps() internally.');
}
