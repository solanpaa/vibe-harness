// Subset of CDD-schema.md §1 — enough to validate FKs, indexes, unique constraints, JSON columns

import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';

// ─── helpers ───────────────────────────────────────────────────────────

const uuid = () =>
  text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());

const createdAt = () =>
  text('created_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString());

const updatedAt = () =>
  text('updated_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString());

// ─── projects ──────────────────────────────────────────────────────────

export const projects = sqliteTable('projects', {
  id: uuid(),
  name: text('name').notNull(),
  gitUrl: text('git_url'),
  localPath: text('local_path').notNull(),
  description: text('description'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// ─── workflowTemplates ─────────────────────────────────────────────────

export const workflowTemplates = sqliteTable('workflow_templates', {
  id: uuid(),
  name: text('name').notNull(),
  description: text('description'),
  stages: text('stages').notNull(),  // JSON: WorkflowStage[]
  isBuiltIn: integer('is_built_in', { mode: 'boolean' }).notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// ─── workflowRuns ──────────────────────────────────────────────────────

export const workflowRuns = sqliteTable(
  'workflow_runs',
  {
    id: uuid(),
    workflowTemplateId: text('workflow_template_id')
      .notNull()
      .references(() => workflowTemplates.id),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    description: text('description'),
    title: text('title'),
    status: text('status').notNull().default('pending'),
    currentStage: text('current_stage'),
    sandboxId: text('sandbox_id'),
    worktreePath: text('worktree_path'),
    branch: text('branch'),
    model: text('model'),
    createdAt: createdAt(),
    completedAt: text('completed_at'),
  },
  (table) => [
    index('idx_workflow_runs_status').on(table.status),
    index('idx_workflow_runs_project').on(table.projectId),
  ],
);

// ─── stageExecutions ───────────────────────────────────────────────────

export const stageExecutions = sqliteTable(
  'stage_executions',
  {
    id: uuid(),
    workflowRunId: text('workflow_run_id')
      .notNull()
      .references(() => workflowRuns.id),
    stageName: text('stage_name').notNull(),
    round: integer('round').notNull().default(1),
    status: text('status').notNull().default('pending'),
    prompt: text('prompt'),
    freshSession: integer('fresh_session', { mode: 'boolean' }).notNull().default(false),
    model: text('model'),
    startedAt: text('started_at'),
    completedAt: text('completed_at'),
    failureReason: text('failure_reason'),
    usageStats: text('usage_stats'),  // JSON: UsageStats
  },
  (table) => [
    uniqueIndex('uq_stage_execution_run_stage_round')
      .on(table.workflowRunId, table.stageName, table.round),
    index('idx_stage_executions_run').on(table.workflowRunId),
  ],
);
