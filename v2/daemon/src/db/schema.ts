// daemon/src/db/schema.ts — Full Drizzle ORM schema (CDD-schema.md §1)

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

// ─── projects (SAD §4.2, SRD FR-P1–P7) ────────────────────────────────

export const projects = sqliteTable('projects', {
  id: uuid(),
  name: text('name').notNull(),
  gitUrl: text('git_url'),
  localPath: text('local_path').notNull(),
  description: text('description'),
  defaultCredentialSetId: text('default_credential_set_id')
    .references(() => credentialSets.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// ─── agentDefinitions (SAD §4.2, SRD FR-A1–A5) ────────────────────────

export const agentDefinitions = sqliteTable('agent_definitions', {
  id: uuid(),
  name: text('name').notNull(),
  type: text('type').notNull(),                     // 'copilot_cli' (MVP)
  commandTemplate: text('command_template').notNull(),
  dockerImage: text('docker_image'),
  description: text('description'),
  supportsStreaming: integer('supports_streaming', { mode: 'boolean' }).notNull().default(true),
  supportsContinue: integer('supports_continue', { mode: 'boolean' }).notNull().default(true),
  supportsIntervention: integer('supports_intervention', { mode: 'boolean' }).notNull().default(true),
  outputFormat: text('output_format').notNull().default('acp'), // 'acp' | 'jsonl' | 'text'
  isBuiltIn: integer('is_built_in', { mode: 'boolean' }).notNull().default(false),
  createdAt: createdAt(),
});

// ─── workflowTemplates (SAD §4.2, SRD FR-W1–W2, FR-W11–W12) ──────────

export const workflowTemplates = sqliteTable('workflow_templates', {
  id: uuid(),
  name: text('name').notNull(),
  description: text('description'),
  stages: text('stages').notNull(),                 // JSON: WorkflowStage[]
  isBuiltIn: integer('is_built_in', { mode: 'boolean' }).notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// ─── workflowRuns (SAD §4.2, SRD FR-W3–W4, FR-W9–W10, FR-W17–W18) ───

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
    agentDefinitionId: text('agent_definition_id')
      .notNull()
      .references(() => agentDefinitions.id),
    parentRunId: text('parent_run_id')
      .references((): any => workflowRuns.id),
    parallelGroupId: text('parallel_group_id')
      .references(() => parallelGroups.id),
    description: text('description'),
    title: text('title'),
    status: text('status').notNull().default('pending'),
    currentStage: text('current_stage'),
    sandboxId: text('sandbox_id'),
    worktreePath: text('worktree_path'),
    branch: text('branch'),
    acpSessionId: text('acp_session_id'),
    credentialSetId: text('credential_set_id')
      .references(() => credentialSets.id),
    baseBranch: text('base_branch'),
    targetBranch: text('target_branch'),
    model: text('model'),
    createdAt: createdAt(),
    completedAt: text('completed_at'),
  },
  (table) => [
    index('idx_workflow_runs_status').on(table.status),
    index('idx_workflow_runs_project').on(table.projectId),
    index('idx_workflow_runs_parent').on(table.parentRunId),
    index('idx_workflow_runs_parallel_group').on(table.parallelGroupId),
  ],
);

// ─── stageExecutions (SAD §4.2, SRD FR-W4–W9, FR-W14) ────────────────

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
    usageStats: text('usage_stats'),                  // JSON: UsageStats
  },
  (table) => [
    uniqueIndex('uq_stage_execution_run_stage_round')
      .on(table.workflowRunId, table.stageName, table.round),
    index('idx_stage_executions_run').on(table.workflowRunId),
  ],
);

// ─── runMessages (SAD §4.2, SRD FR-W19) ───────────────────────────────

export const runMessages = sqliteTable(
  'run_messages',
  {
    id: uuid(),
    workflowRunId: text('workflow_run_id')
      .notNull()
      .references(() => workflowRuns.id, { onDelete: 'cascade' }),
    stageName: text('stage_name').notNull(),
    round: integer('round').notNull().default(1),
    sessionBoundary: integer('session_boundary', { mode: 'boolean' }).notNull().default(false),
    role: text('role').notNull(),                    // 'user' | 'assistant' | 'system' | 'tool'
    content: text('content').notNull(),
    isIntervention: integer('is_intervention', { mode: 'boolean' }).notNull().default(false),
    metadata: text('metadata'),                      // JSON: tool calls, reasoning, etc.
    createdAt: createdAt(),
  },
  (table) => [
    index('idx_run_messages_run').on(table.workflowRunId),
    index('idx_run_messages_run_stage').on(table.workflowRunId, table.stageName),
  ],
);

// ─── reviews (SAD §4.2, SRD FR-R1–R11) ────────────────────────────────
// DESIGN NOTE: SQLite treats each NULL as distinct in UNIQUE indexes.
// We use '__consolidation__' sentinel instead of NULL for consolidation reviews.

export const reviews = sqliteTable(
  'reviews',
  {
    id: uuid(),
    workflowRunId: text('workflow_run_id')
      .notNull()
      .references(() => workflowRuns.id),
    stageName: text('stage_name').notNull(),          // '__consolidation__' for consolidation reviews
    round: integer('round').notNull().default(1),
    type: text('type').notNull().default('stage'),   // 'stage' | 'consolidation'
    status: text('status').notNull().default('pending_review'),
    aiSummary: text('ai_summary'),
    diffSnapshot: text('diff_snapshot'),
    planMarkdown: text('plan_markdown'),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('uq_review_run_stage_round_type')
      .on(table.workflowRunId, table.stageName, table.round, table.type),
    index('idx_reviews_run').on(table.workflowRunId),
  ],
);

// ─── reviewComments (SAD §4.2, SRD FR-R4–R5) ──────────────────────────

export const reviewComments = sqliteTable(
  'review_comments',
  {
    id: uuid(),
    reviewId: text('review_id')
      .notNull()
      .references(() => reviews.id, { onDelete: 'cascade' }),
    filePath: text('file_path'),
    lineNumber: integer('line_number'),
    side: text('side'),                              // 'left' | 'right'
    body: text('body').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index('idx_review_comments_review').on(table.reviewId),
  ],
);

// ─── proposals (SAD §4.2, SRD FR-S1–S6) ───────────────────────────────

export const proposals = sqliteTable(
  'proposals',
  {
    id: uuid(),
    workflowRunId: text('workflow_run_id')
      .notNull()
      .references(() => workflowRuns.id, { onDelete: 'cascade' }),
    stageName: text('stage_name').notNull(),
    parallelGroupId: text('parallel_group_id')
      .references(() => parallelGroups.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    description: text('description').notNull(),
    affectedFiles: text('affected_files'),           // JSON: string[]
    dependsOn: text('depends_on'),                   // JSON: string[]
    workflowTemplateOverride: text('workflow_template_override')
      .references(() => workflowTemplates.id),
    status: text('status').notNull().default('proposed'),
    launchedWorkflowRunId: text('launched_workflow_run_id')
      .references(() => workflowRuns.id),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('uq_proposal_run_stage_title')
      .on(table.workflowRunId, table.stageName, table.title),
    index('idx_proposals_run').on(table.workflowRunId),
    index('idx_proposals_parallel_group').on(table.parallelGroupId),
  ],
);

// ─── parallelGroups (SAD §4.2, SRD FR-S7–S13) ─────────────────────────

export const parallelGroups = sqliteTable(
  'parallel_groups',
  {
    id: uuid(),
    sourceWorkflowRunId: text('source_workflow_run_id')
      .notNull()
      .references(() => workflowRuns.id),
    name: text('name'),
    description: text('description'),
    status: text('status').notNull().default('pending'),
    createdAt: createdAt(),
    completedAt: text('completed_at'),
  },
  (table) => [
    index('idx_parallel_groups_source_run').on(table.sourceWorkflowRunId),
  ],
);

// ─── credentialSets (SAD §4.2, SRD FR-C1, FR-C6) ──────────────────────

export const credentialSets = sqliteTable(
  'credential_sets',
  {
    id: uuid(),
    name: text('name').notNull(),
    description: text('description'),
    projectId: text('project_id')
      .references(() => projects.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (table) => [
    index('idx_credential_sets_project').on(table.projectId),
  ],
);

// ─── credentialEntries (SAD §4.2, SRD FR-C2–C4, SAD §6.2) ─────────────

export const credentialEntries = sqliteTable(
  'credential_entries',
  {
    id: uuid(),
    credentialSetId: text('credential_set_id')
      .notNull()
      .references(() => credentialSets.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    value: text('value').notNull().default(''),      // AES-256 encrypted; empty for command_extract
    type: text('type').notNull(),                    // CredentialEntryType
    mountPath: text('mount_path'),
    command: text('command'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('idx_credential_entries_set').on(table.credentialSetId),
  ],
);

// ─── credentialAuditLog (SAD §4.2, SRD FR-C5) ─────────────────────────

export const credentialAuditLog = sqliteTable(
  'credential_audit_log',
  {
    id: uuid(),
    action: text('action').notNull(),
    credentialSetId: text('credential_set_id'),
    credentialEntryId: text('credential_entry_id'),
    workflowRunId: text('workflow_run_id'),
    details: text('details'),                        // JSON
    createdAt: createdAt(),
  },
  (table) => [
    index('idx_credential_audit_set').on(table.credentialSetId),
    index('idx_credential_audit_run').on(table.workflowRunId),
  ],
);

// ─── lastRunConfig (SAD §4.2) — singleton ──────────────────────────────

export const lastRunConfig = sqliteTable('last_run_config', {
  id: integer('id').primaryKey().default(1),
  projectId: text('project_id'),
  agentDefinitionId: text('agent_definition_id'),
  credentialSetId: text('credential_set_id'),
  workflowTemplateId: text('workflow_template_id'),
  updatedAt: updatedAt(),
});

// ─── hookResumes (SAD §4.2, §5.3.1) — outbox pattern ──────────────────

export const hookResumes = sqliteTable('hook_resumes', {
  id: uuid(),
  hookToken: text('hook_token').notNull().unique(),
  action: text('action').notNull(),                // JSON: serialized payload
  createdAt: createdAt(),
});

// ─── gitOperations (SAD §4.2, §5.5.3) — durable journal ───────────────

export const gitOperations = sqliteTable(
  'git_operations',
  {
    id: uuid(),
    type: text('type').notNull(),                    // 'finalize' | 'consolidate'
    workflowRunId: text('workflow_run_id')
      .notNull()
      .references(() => workflowRuns.id),
    parallelGroupId: text('parallel_group_id'),
    phase: text('phase').notNull(),                  // 'commit'|'rebase'|'merge'|'cleanup'|'done'
    metadata: text('metadata'),                      // JSON: GitOperationMetadata
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('uq_git_op_run_type').on(table.workflowRunId, table.type),
  ],
);
