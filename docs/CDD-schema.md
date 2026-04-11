# Vibe Harness v2 — Component Detailed Design: Database Schema & Types

> **CDD-schema** — Implementable code for the persistence layer and shared type system.
>
> **Parent document:** [SAD.md](./SAD.md) §4.2–4.3, §3.2, §8.2
> **Traceability:** [SRD.md](./SRD.md) §2–3

---

## 1. Drizzle ORM Schema (`daemon/src/db/schema.ts`)

Complete Drizzle ORM schema for SQLite. Every table, column, constraint, index, and
foreign key from SAD §4.2 is represented below.

**Conventions:**
- Primary keys: UUID text with `crypto.randomUUID()` default (SAD §4.1)
- Timestamps: ISO 8601 text with `new Date().toISOString()` default (SAD §4.1)
- JSON fields: stored as text, serialized/deserialized in the application layer
- Booleans: SQLite integer (0/1) via Drizzle `integer(..., { mode: 'boolean' })`
- Foreign keys declared inline via `.references()`
- Sentinel values used where SQLite NULL-in-UNIQUE semantics are problematic (see `reviews.stageName`)
- Cross-field invariants that Drizzle cannot express are documented as `CHECK` comments for raw SQL migrations

```typescript
// daemon/src/db/schema.ts

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
  // CDD design decision: onDelete 'set null' chosen so deleting a credential set
  // does not cascade to project deletion — it merely clears the default.
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
  isBuiltIn: integer('is_built_in', { mode: 'boolean' }).notNull().default(false), // seed data protection
  createdAt: createdAt(),
});

// ─── workflowTemplates (SAD §4.2, SRD FR-W1–W2, FR-W11–W12) ──────────

export const workflowTemplates = sqliteTable('workflow_templates', {
  id: uuid(),
  name: text('name').notNull(),
  description: text('description'),
  stages: text('stages').notNull(),                 // JSON: WorkflowStage[]
  isBuiltIn: integer('is_built_in', { mode: 'boolean' }).notNull().default(false), // seed data protection
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// ─── workflowRuns (SAD §4.2, SRD FR-W3–W4, FR-W9–W10, FR-W17–W18) ───
// CHECK invariants (enforce via raw SQL migration or service layer):
//   - parentRunId IS NOT NULL implies parallelGroupId IS NOT NULL (split children belong to a group)
//   - status IN ('pending','provisioning','running','stage_failed','awaiting_review',
//     'awaiting_proposals','waiting_for_children','children_completed_with_failures',
//     'awaiting_conflict_resolution','finalizing','completed','failed','cancelled')

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
      .references((): any => workflowRuns.id),      // non-NULL for split children
    parallelGroupId: text('parallel_group_id')
      .references(() => parallelGroups.id),          // non-NULL for split children
    description: text('description'),                // user's run description
    title: text('title'),                            // auto-generated or user-provided
    status: text('status').notNull().default('pending'), // WorkflowRunStatus
    currentStage: text('current_stage'),
    sandboxId: text('sandbox_id'),                   // Docker sandbox name
    worktreePath: text('worktree_path'),             // filesystem path to worktree
    branch: text('branch'),                          // LLM-generated branch name
    acpSessionId: text('acp_session_id'),            // current ACP session
    credentialSetId: text('credential_set_id')
      .references(() => credentialSets.id),
    baseBranch: text('base_branch'),                 // branch worktree was created from
    targetBranch: text('target_branch'),             // branch to merge into on approval
    model: text('model'),                            // run-level model override (FR-W23)
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
// CHECK invariants (enforce via raw SQL migration or service layer):
//   - status IN ('pending','running','completed','failed','skipped')
//   - round >= 1
//   - freshSession IN (0, 1)

export const stageExecutions = sqliteTable(
  'stage_executions',
  {
    id: uuid(),
    workflowRunId: text('workflow_run_id')
      .notNull()
      .references(() => workflowRuns.id),
    stageName: text('stage_name').notNull(),
    round: integer('round').notNull().default(1),    // increments on request_changes
    status: text('status').notNull().default('pending'), // StageStatus
    prompt: text('prompt'),                          // built prompt for this stage+round
    freshSession: integer('fresh_session', { mode: 'boolean' }).notNull().default(false),
    model: text('model'),                            // resolved model used for this execution (FR-W23)
    startedAt: text('started_at'),
    completedAt: text('completed_at'),
    failureReason: text('failure_reason'),            // StageFailureReason enum value
    usageStats: text('usage_stats'),                  // JSON: UsageStats (durationMs in milliseconds)
  },
  (table) => [
    // Idempotency constraint (SAD §4.2)
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
// DESIGN NOTE: SQLite treats each NULL as distinct in UNIQUE indexes, which would
// allow duplicate consolidation reviews for the same (runId, round, type). To fix this,
// we use the sentinel value '__consolidation__' instead of NULL for consolidation
// reviews. The application layer maps this sentinel to/from `null` in entity types.

export const reviews = sqliteTable(
  'reviews',
  {
    id: uuid(),
    workflowRunId: text('workflow_run_id')
      .notNull()
      .references(() => workflowRuns.id),
    stageName: text('stage_name').notNull(),          // '__consolidation__' for consolidation reviews
    round: integer('round').notNull().default(1),
    type: text('type').notNull().default('stage'),   // ReviewType: 'stage' | 'consolidation'
    status: text('status').notNull().default('pending_review'), // ReviewStatus
    aiSummary: text('ai_summary'),
    diffSnapshot: text('diff_snapshot'),
    planMarkdown: text('plan_markdown'),
    createdAt: createdAt(),
  },
  (table) => [
    // Idempotency constraint (SAD §4.2) — uses sentinel for consolidation, so UNIQUE works correctly
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
    filePath: text('file_path'),                     // NULL for general comments
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
    dependsOn: text('depends_on'),                   // JSON: string[] (metadata only)
    workflowTemplateOverride: text('workflow_template_override')
      .references(() => workflowTemplates.id),
    status: text('status').notNull().default('proposed'), // ProposalStatus
    launchedWorkflowRunId: text('launched_workflow_run_id')
      .references(() => workflowRuns.id),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    // Idempotency constraint (SAD §4.2)
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
    status: text('status').notNull().default('pending'), // ParallelGroupStatus
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
// DESIGN NOTE: `value` is NOT NULL but may be empty string for command_extract entries,
// where the extracted token is computed at runtime from the `command` field.
// CHECK invariant (service layer): type='file_mount'|'host_dir_mount' → mountPath IS NOT NULL
// CHECK invariant (service layer): type='command_extract' → command IS NOT NULL

export const credentialEntries = sqliteTable(
  'credential_entries',
  {
    id: uuid(),
    credentialSetId: text('credential_set_id')
      .notNull()
      .references(() => credentialSets.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    value: text('value').notNull().default(''),      // AES-256 encrypted (SRD FR-C3); empty for command_extract
    type: text('type').notNull(),                    // CredentialEntryType
    mountPath: text('mount_path'),                   // for file_mount, host_dir_mount
    command: text('command'),                        // for command_extract
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
// CHECK constraint for raw SQL migration: CHECK(id = 1)
// Drizzle cannot express this; enforce via migration or service layer.

export const lastRunConfig = sqliteTable('last_run_config', {
  id: integer('id').primaryKey().default(1),         // singleton row — always id=1
  projectId: text('project_id'),
  agentDefinitionId: text('agent_definition_id'),
  credentialSetId: text('credential_set_id'),
  workflowTemplateId: text('workflow_template_id'),
  updatedAt: updatedAt(),
});

// ─── hookResumes (SAD §4.2, §5.3.1) — outbox pattern ──────────────────

export const hookResumes = sqliteTable(
  'hook_resumes',
  {
    id: uuid(),
    hookToken: text('hook_token').notNull().unique(),
    action: text('action').notNull(),                // JSON: serialized Record<string, unknown> payload
    createdAt: createdAt(),
  },
);

// ─── gitOperations (SAD §4.2, §5.5.3) — durable journal ───────────────

export const gitOperations = sqliteTable(
  'git_operations',
  {
    id: uuid(),
    type: text('type').notNull(),                    // 'finalize' | 'consolidate'
    workflowRunId: text('workflow_run_id')
      .notNull()
      .references(() => workflowRuns.id),
    parallelGroupId: text('parallel_group_id'),      // for consolidate
    phase: text('phase').notNull(),                  // 'commit'|'rebase'|'merge'|'cleanup'|'done' etc.
    metadata: text('metadata'),                      // JSON: GitOperationMetadata
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    // One active operation per workflow run per type (SAD §4.2)
    uniqueIndex('uq_git_op_run_type').on(table.workflowRunId, table.type),
  ],
);
```

---

## 2. TypeScript Types (`shared/types/`)

### 2.1 Status Enums (`shared/types/enums.ts`)

Enumerations from SAD §4.3. Defined as `const` objects + extracted types for
runtime validation and exhaustive switch checking.

```typescript
// shared/types/enums.ts

// ─── Workflow run lifecycle (SAD §4.3, SRD FR-W9–W10, FR-S7, FR-S10) ──

export const WorkflowRunStatus = {
  Pending: 'pending',
  Provisioning: 'provisioning',
  Running: 'running',
  StageFailed: 'stage_failed',
  AwaitingReview: 'awaiting_review',
  AwaitingProposals: 'awaiting_proposals',
  WaitingForChildren: 'waiting_for_children',
  ChildrenCompletedWithFailures: 'children_completed_with_failures',
  AwaitingConflictResolution: 'awaiting_conflict_resolution',
  Finalizing: 'finalizing',
  Completed: 'completed',
  Failed: 'failed',
  Cancelled: 'cancelled',
} as const;

export type WorkflowRunStatus = (typeof WorkflowRunStatus)[keyof typeof WorkflowRunStatus];

/** Status values that indicate a run is no longer executing. */
export const TERMINAL_RUN_STATUSES: readonly WorkflowRunStatus[] = [
  WorkflowRunStatus.Completed,
  WorkflowRunStatus.Failed,
  WorkflowRunStatus.Cancelled,
];

// ─── Stage execution lifecycle (SAD §4.3) ──────────────────────────────

export const StageStatus = {
  Pending: 'pending',
  Running: 'running',
  Completed: 'completed',
  Failed: 'failed',
  Skipped: 'skipped',
} as const;

export type StageStatus = (typeof StageStatus)[keyof typeof StageStatus];

// ─── Review lifecycle (SAD §4.3, SRD FR-R1–R8) ────────────────────────

export const ReviewType = {
  Stage: 'stage',
  Consolidation: 'consolidation',
} as const;

export type ReviewType = (typeof ReviewType)[keyof typeof ReviewType];

export const ReviewStatus = {
  PendingReview: 'pending_review',
  Approved: 'approved',
  ChangesRequested: 'changes_requested',
} as const;

export type ReviewStatus = (typeof ReviewStatus)[keyof typeof ReviewStatus];

// ─── Parallel group lifecycle (SAD §4.3, SRD FR-S7–S13) ───────────────

export const ParallelGroupStatus = {
  Pending: 'pending',
  Running: 'running',
  ChildrenCompleted: 'children_completed',
  ChildrenMixed: 'children_mixed',
  Consolidating: 'consolidating',
  Completed: 'completed',
  Failed: 'failed',
  Cancelled: 'cancelled',
} as const;

export type ParallelGroupStatus = (typeof ParallelGroupStatus)[keyof typeof ParallelGroupStatus];

// ─── Proposal lifecycle (SAD §4.3, SRD FR-S1–S4) ──────────────────────

export const ProposalStatus = {
  Proposed: 'proposed',
  Approved: 'approved',
  Launched: 'launched',
  Discarded: 'discarded',
} as const;

export type ProposalStatus = (typeof ProposalStatus)[keyof typeof ProposalStatus];

// ─── Credential entry type (SAD §4.2, §6.2, SRD FR-C2) ────────────────

export const CredentialEntryType = {
  EnvVar: 'env_var',
  FileMount: 'file_mount',
  DockerLogin: 'docker_login',
  HostDirMount: 'host_dir_mount',
  CommandExtract: 'command_extract',
} as const;

export type CredentialEntryType = (typeof CredentialEntryType)[keyof typeof CredentialEntryType];

// ─── Run message role (SAD §4.2) ───────────────────────────────────────

export const MessageRole = {
  User: 'user',
  Assistant: 'assistant',
  System: 'system',
  Tool: 'tool',
} as const;

export type MessageRole = (typeof MessageRole)[keyof typeof MessageRole];

// ─── Agent output format (SAD §4.2) ────────────────────────────────────

export const AgentOutputFormat = {
  Acp: 'acp',
  Jsonl: 'jsonl',
  Text: 'text',
} as const;

export type AgentOutputFormat = (typeof AgentOutputFormat)[keyof typeof AgentOutputFormat];

// ─── Agent type (SAD §4.2) ─────────────────────────────────────────────

export const AgentType = {
  CopilotCli: 'copilot_cli',
} as const;

export type AgentType = (typeof AgentType)[keyof typeof AgentType];

// ─── Diff comment side (SAD §4.2) ──────────────────────────────────────

export const DiffSide = {
  Left: 'left',
  Right: 'right',
} as const;

export type DiffSide = (typeof DiffSide)[keyof typeof DiffSide];

// ─── Git operation type & phase (SAD §5.5.3) ───────────────────────────

export const GitOperationType = {
  Finalize: 'finalize',
  Consolidate: 'consolidate',
} as const;

export type GitOperationType = (typeof GitOperationType)[keyof typeof GitOperationType];

export const GitFinalizePhase = {
  Commit: 'commit',
  Rebase: 'rebase',
  Merge: 'merge',
  Cleanup: 'cleanup',
  Done: 'done',
} as const;

export const GitConsolidatePhase = {
  SnapshotParent: 'snapshot_parent',
  MergeChildren: 'merge_children',
  FfParent: 'ff_parent',
  Cleanup: 'cleanup',
  Done: 'done',
} as const;

export type GitOperationPhase =
  | (typeof GitFinalizePhase)[keyof typeof GitFinalizePhase]
  | (typeof GitConsolidatePhase)[keyof typeof GitConsolidatePhase];

// ─── Stage failure reason (SAD §4.2, SRD NFR-R2) ──────────────────────

export const StageFailureReason = {
  DaemonRestart: 'daemon_restart',
  AgentError: 'agent_error',
  Timeout: 'timeout',
  Cancelled: 'cancelled',
} as const;

export type StageFailureReason = (typeof StageFailureReason)[keyof typeof StageFailureReason];

// ─── Workflow stage type (SRD FR-W2) ───────────────────────────────────

export const StageType = {
  Standard: 'standard',
  Split: 'split',
} as const;

export type StageType = (typeof StageType)[keyof typeof StageType];
```

### 2.2 Entity Types (`shared/types/entities.ts`)

Entity types match the DB schema but with parsed JSON fields.
These are what services return and routes serialize.

```typescript
// shared/types/entities.ts

import type {
  WorkflowRunStatus, StageStatus, StageFailureReason, ReviewType, ReviewStatus,
  ParallelGroupStatus, ProposalStatus, CredentialEntryType,
  MessageRole, AgentOutputFormat, AgentType, DiffSide,
  GitOperationType, GitOperationPhase, StageType,
} from './enums';

// ─── Workflow stage template (JSON inside workflowTemplates.stages) ────

/** A single stage definition within a workflow template (SRD FR-W2). */
export interface WorkflowStage {
  name: string;
  type: StageType;                                 // 'standard' | 'split'
  promptTemplate: string;
  reviewRequired: boolean;
  autoAdvance: boolean;                             // mutually exclusive with reviewRequired
  freshSession: boolean;
  model?: string;                                   // per-stage model override (FR-W23)
  isFinal?: boolean;                                // explicit last-stage marker (SAD §5.5.2)
}

// ─── projects ──────────────────────────────────────────────────────────

export interface Project {
  id: string;
  name: string;
  gitUrl: string | null;
  localPath: string;
  description: string | null;
  defaultCredentialSetId: string | null;
  createdAt: string;
  updatedAt: string;
}

// ─── agentDefinitions ──────────────────────────────────────────────────

export interface AgentDefinition {
  id: string;
  name: string;
  type: AgentType;
  commandTemplate: string;
  dockerImage: string | null;
  description: string | null;
  supportsStreaming: boolean;
  supportsContinue: boolean;
  supportsIntervention: boolean;
  outputFormat: AgentOutputFormat;
  isBuiltIn: boolean;
  createdAt: string;
}

// ─── workflowTemplates ─────────────────────────────────────────────────

export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string | null;
  stages: WorkflowStage[];                         // parsed from JSON text column
  isBuiltIn: boolean;
  createdAt: string;
  updatedAt: string;
}

// ─── workflowRuns ──────────────────────────────────────────────────────

export interface WorkflowRun {
  id: string;
  workflowTemplateId: string;
  projectId: string;
  agentDefinitionId: string;
  parentRunId: string | null;
  parallelGroupId: string | null;
  description: string | null;
  title: string | null;
  status: WorkflowRunStatus;
  currentStage: string | null;
  sandboxId: string | null;
  worktreePath: string | null;
  branch: string | null;
  acpSessionId: string | null;
  credentialSetId: string | null;
  baseBranch: string | null;
  targetBranch: string | null;
  model: string | null;                            // run-level model override (FR-W23)
  createdAt: string;
  completedAt: string | null;
}

// ─── stageExecutions ───────────────────────────────────────────────────

export interface UsageStats {
  tokens?: number;
  durationMs?: number;                             // milliseconds
  cost?: number;                                   // USD
  model?: string;
}

export interface StageExecution {
  id: string;
  workflowRunId: string;
  stageName: string;
  round: number;
  status: StageStatus;
  prompt: string | null;
  freshSession: boolean;
  model: string | null;                            // resolved model used for this execution (FR-W23)
  startedAt: string | null;
  completedAt: string | null;
  failureReason: StageFailureReason | null;
  usageStats: UsageStats | null;                   // parsed from JSON
}

// ─── runMessages ───────────────────────────────────────────────────────

export interface RunMessageMetadata {
  toolName?: string;
  toolCallId?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: unknown;
  thought?: string;
  [key: string]: unknown;
}

export interface RunMessage {
  id: string;
  workflowRunId: string;
  stageName: string;
  round: number;
  sessionBoundary: boolean;
  role: MessageRole;
  content: string;
  isIntervention: boolean;
  metadata: RunMessageMetadata | null;             // parsed from JSON
  createdAt: string;
}

// ─── reviews ───────────────────────────────────────────────────────────

/**
 * Sentinel value stored in reviews.stageName for consolidation reviews.
 * Maps to `null` in the Review entity type for API consumers.
 */
export const CONSOLIDATION_STAGE_SENTINEL = '__consolidation__' as const;

export interface Review {
  id: string;
  workflowRunId: string;
  stageName: string | null;                          // null for consolidation reviews (DB stores sentinel)
  round: number;
  type: ReviewType;
  status: ReviewStatus;
  aiSummary: string | null;
  diffSnapshot: string | null;
  planMarkdown: string | null;
  createdAt: string;
}

// ─── reviewComments ────────────────────────────────────────────────────

export interface ReviewComment {
  id: string;
  reviewId: string;
  filePath: string | null;
  lineNumber: number | null;
  side: DiffSide | null;
  body: string;
  createdAt: string;
}

// ─── proposals ─────────────────────────────────────────────────────────

export interface Proposal {
  id: string;
  workflowRunId: string;
  stageName: string;
  parallelGroupId: string | null;
  title: string;
  description: string;
  affectedFiles: string[] | null;                  // parsed from JSON
  dependsOn: string[] | null;                      // parsed from JSON
  workflowTemplateOverride: string | null;
  status: ProposalStatus;
  launchedWorkflowRunId: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

// ─── parallelGroups ────────────────────────────────────────────────────

export interface ParallelGroup {
  id: string;
  sourceWorkflowRunId: string;
  name: string | null;
  description: string | null;
  status: ParallelGroupStatus;
  createdAt: string;
  completedAt: string | null;
}

// ─── credentialSets ────────────────────────────────────────────────────

export interface CredentialSet {
  id: string;
  name: string;
  description: string | null;
  projectId: string | null;
  createdAt: string;
}

// ─── credentialEntries ─────────────────────────────────────────────────

/** Base credential entry with encrypted value masked for API responses. */
export interface CredentialEntry {
  id: string;
  credentialSetId: string;
  key: string;
  type: CredentialEntryType;
  mountPath: string | null;
  command: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Internal-only: includes the decrypted value.
 * NEVER returned from API routes (SRD FR-C7, NFR-S7).
 */
export interface CredentialEntryWithValue extends CredentialEntry {
  value: string;                                    // may be empty for command_extract
}

/** Credential entry shapes per type (SAD §6.2). */
export interface EnvVarCredential {
  type: 'env_var';
  key: string;       // environment variable name
  value: string;     // environment variable value
}

export interface FileMountCredential {
  type: 'file_mount';
  key: string;       // identifier
  value: string;     // file content
  mountPath: string; // target path in sandbox
}

export interface DockerLoginCredential {
  type: 'docker_login';
  key: string;       // registry URL
  value: string;     // JSON: { username: string; password: string }
}

export interface HostDirMountCredential {
  type: 'host_dir_mount';
  key: string;       // identifier
  value: string;     // host directory path (e.g., ~/.azure)
  mountPath: string; // target path in sandbox (e.g., /home/user/.azure)
}

export interface CommandExtractCredential {
  type: 'command_extract';
  key: string;       // env var name to store result
  command: string;   // host command to run at sandbox boot
  value?: undefined; // not used — token is extracted at runtime from `command`
}

export type TypedCredentialEntry =
  | EnvVarCredential
  | FileMountCredential
  | DockerLoginCredential
  | HostDirMountCredential
  | CommandExtractCredential;

// ─── credentialAuditLog ────────────────────────────────────────────────

export interface CredentialAuditLogEntry {
  id: string;
  action: string;
  credentialSetId: string | null;
  credentialEntryId: string | null;
  workflowRunId: string | null;
  details: Record<string, unknown> | null;         // parsed from JSON
  createdAt: string;
}

// ─── lastRunConfig ─────────────────────────────────────────────────────

export interface LastRunConfig {
  id: number;
  projectId: string | null;
  agentDefinitionId: string | null;
  credentialSetId: string | null;
  workflowTemplateId: string | null;
  updatedAt: string;
}

// ─── hookResumes ───────────────────────────────────────────────────────

export interface HookResume {
  id: string;
  hookToken: string;
  action: Record<string, unknown>;                  // parsed from JSON
  createdAt: string;
}

// ─── gitOperations ─────────────────────────────────────────────────────

export interface GitOperationMetadata {
  targetBranch?: string;
  mergedChildren?: string[];
  conflictChild?: string;
  consolidationBranch?: string;
  mergeOrder?: string[];
  [key: string]: unknown;
}

export interface GitOperation {
  id: string;
  type: GitOperationType;
  workflowRunId: string;
  parallelGroupId: string | null;
  phase: GitOperationPhase;
  metadata: GitOperationMetadata | null;           // parsed from JSON
  createdAt: string;
  updatedAt: string;
}
```

### 2.3 WebSocket Event Types (`shared/types/events.ts`)

From SAD §3.2 WebSocket protocol, reconciled with CDD-api §12.

```typescript
// shared/types/events.ts

import type {
  WorkflowRunStatus, StageStatus, StageFailureReason,
  ReviewStatus, ReviewType, ParallelGroupStatus,
} from './enums';

// ─── Agent output events (ACP → daemon → WebSocket) ───────────────────

export interface AgentOutputEvent {
  role: 'assistant' | 'tool' | 'system' | 'user';
  content: string;
  eventType:
    | 'agent_message'
    | 'agent_thought'
    | 'tool_call'
    | 'tool_result'
    | 'session_update'
    | 'result'
    | 'intervention'
    | 'system_prompt';
  metadata?: {
    toolName?: string;
    toolCallId?: string;
    toolArgs?: Record<string, unknown>;
    isStreaming?: boolean;                          // true for partial messages during streaming
    usageStats?: { tokens?: number; durationMs?: number; cost?: number; model?: string };
  };
  timestamp: string;
}

// ─── Client → Server messages (SAD §3.2) ──────────────────────────────

export interface SubscribeMessage {
  type: 'subscribe';
  runId: string;
  lastSeq?: number;                                // for reconnection replay
}

export interface UnsubscribeMessage {
  type: 'unsubscribe';
  runId: string;
}

export interface PingMessage {
  type: 'ping';
}

export type ClientMessage = SubscribeMessage | UnsubscribeMessage | PingMessage;

// ─── Server → Client messages (SAD §3.2, CDD-api §12.3) ──────────────

export interface ConnectedMessage {
  type: 'connected';
  serverVersion: string;
}

export interface RunOutputMessage {
  type: 'run_output';
  runId: string;
  seq: number;
  stageName: string;
  round: number;
  data: AgentOutputEvent;
}

export interface RunStatusMessage {
  type: 'run_status';
  runId: string;
  status: WorkflowRunStatus;
  currentStage: string | null;
  title: string | null;
  projectId: string;
}

export interface StageStatusMessage {
  type: 'stage_status';
  runId: string;
  stageName: string;
  round: number;
  status: StageStatus;
  failureReason: StageFailureReason | null;
}

export interface ReviewCreatedMessage {
  type: 'review_created';
  reviewId: string;
  runId: string;
  stageName: string | null;
  round: number;
  reviewType: ReviewType;
}

export interface ReviewStatusMessage {
  type: 'review_status';
  reviewId: string;
  runId: string;
  status: ReviewStatus;
}

export interface ProposalsReadyMessage {
  type: 'proposals_ready';
  runId: string;
  stageName: string;
  proposalCount: number;
}

export interface ConflictDetectedMessage {
  type: 'conflict_detected';
  runId: string;
  conflictType: 'rebase' | 'merge';
  conflictDetails: string;
}

export interface ParallelGroupStatusMessage {
  type: 'parallel_group_status';
  parallelGroupId: string;
  runId: string;
  status: ParallelGroupStatus;
}

export interface NotificationMessage {
  type: 'notification';
  level: 'info' | 'warning' | 'error';
  message: string;
  runId?: string;
}

export interface ResyncRequiredMessage {
  type: 'resync_required';
  runId: string;
  reason: string;
}

export interface PongMessage {
  type: 'pong';
}

export type ServerMessage =
  | ConnectedMessage
  | RunOutputMessage
  | RunStatusMessage
  | StageStatusMessage
  | ReviewCreatedMessage
  | ReviewStatusMessage
  | ProposalsReadyMessage
  | ConflictDetectedMessage
  | ParallelGroupStatusMessage
  | NotificationMessage
  | ResyncRequiredMessage
  | PongMessage;
```

### 2.4 API Request/Response Types (`shared/types/api.ts`)

Request and response shapes for every API endpoint group (SAD §8.2),
reconciled with CDD-api.md for GUI-oriented richness.

```typescript
// shared/types/api.ts

import type {
  Project, AgentDefinition, WorkflowTemplate, WorkflowRun,
  StageExecution, RunMessage, Review, ReviewComment, Proposal,
  ParallelGroup, CredentialSet, CredentialEntry, LastRunConfig,
  WorkflowStage, UsageStats,
} from './entities';
import type {
  WorkflowRunStatus, StageStatus, StageFailureReason,
  ProposalStatus, ReviewType,
} from './enums';

// ─── Standard error response (SAD §3.1) ────────────────────────────────

export interface ApiError {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

// ─── Projects (SAD §8.2, SRD FR-P1–P7) ────────────────────────────────

export interface CreateProjectRequest {
  name: string;
  localPath: string;
  gitUrl?: string;
  description?: string;
  defaultCredentialSetId?: string;
}

export interface UpdateProjectRequest {
  name?: string;
  description?: string;
  defaultCredentialSetId?: string | null;
}

export interface ProjectListResponse {
  projects: Project[];
}

export interface ProjectDetailResponse {
  project: Project;
}

export interface ProjectBranchesResponse {
  branches: string[];
  current: string | null;
}

// ─── Agents (SAD §8.1, SRD FR-A1–A5) ──────────────────────────────────

export interface CreateAgentDefinitionRequest {
  name: string;
  type: string;
  commandTemplate: string;
  dockerImage?: string;
  description?: string;
  supportsStreaming?: boolean;
  supportsContinue?: boolean;
  supportsIntervention?: boolean;
  outputFormat?: string;
}

export interface UpdateAgentDefinitionRequest {
  name?: string;
  commandTemplate?: string;
  dockerImage?: string;
  description?: string;
  supportsStreaming?: boolean;
  supportsContinue?: boolean;
  supportsIntervention?: boolean;
  outputFormat?: string;
}

export interface AgentDefinitionListResponse {
  agents: AgentDefinition[];
}

export interface AgentDefinitionDetailResponse {
  agent: AgentDefinition;
}

// ─── Workflow Templates (SAD §8.2, SRD FR-W1–W2, FR-W11–W12) ──────────

export interface CreateWorkflowTemplateRequest {
  name: string;
  description?: string;
  stages: WorkflowStage[];
}

export interface UpdateWorkflowTemplateRequest {
  name?: string;
  description?: string;
  stages?: WorkflowStage[];
}

export interface WorkflowTemplateListResponse {
  templates: WorkflowTemplate[];
}

export interface WorkflowTemplateDetailResponse {
  template: WorkflowTemplate;
}

// ─── Workflow Runs (SAD §8.2, SRD FR-W3–W22) ──────────────────────────

export interface CreateWorkflowRunRequest {
  projectId: string;
  workflowTemplateId: string;
  agentDefinitionId: string;
  description: string;
  credentialSetId?: string;
  baseBranch?: string;
  targetBranch?: string;
  title?: string;
  model?: string;                                  // run-level model override (FR-W23)
}

export interface WorkflowRunListQuery {
  status?: WorkflowRunStatus | WorkflowRunStatus[];
  projectId?: string;
  parentRunId?: string;
}

/** Lightweight summary for run list views — includes denormalized names. */
export interface WorkflowRunSummary {
  id: string;
  title: string | null;
  description: string | null;
  status: WorkflowRunStatus;
  currentStage: string | null;
  projectId: string;
  projectName: string;                             // denormalized from projects
  workflowTemplateName: string;                    // denormalized from workflowTemplates
  branch: string | null;
  parentRunId: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface WorkflowRunListResponse {
  runs: WorkflowRunSummary[];
  total: number;
}

/** Stage execution with cross-referenced review ID for detail views. */
export interface StageExecutionDetail extends StageExecution {
  reviewId: string | null;                         // most recent review for this stage+round
}

export interface WorkflowRunDetailResponse {
  id: string;
  title: string | null;
  description: string | null;
  status: WorkflowRunStatus;
  currentStage: string | null;
  projectId: string;
  projectName: string;
  workflowTemplateId: string;
  workflowTemplateName: string;
  agentDefinitionId: string;
  parentRunId: string | null;
  parallelGroupId: string | null;
  sandboxId: string | null;
  worktreePath: string | null;
  branch: string | null;
  baseBranch: string | null;
  targetBranch: string | null;
  credentialSetId: string | null;
  createdAt: string;
  completedAt: string | null;
  stages: StageExecutionDetail[];
  activeReviewId: string | null;                   // review currently pending, if any
  childRunIds: string[];                           // IDs of split-child runs
}

// ─── Diff types (shared between runs and reviews) ──────────────────────

export interface DiffChunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  content: string;
}

export interface DiffFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  oldPath?: string;                                // for renames
  additions: number;
  deletions: number;
  chunks: DiffChunk[];
}

export interface DiffStats {
  filesChanged: number;
  additions: number;
  deletions: number;
}

export interface WorkflowRunDiffResponse {
  diff: string;                                    // raw unified diff text
  files: DiffFile[];                               // structured parsed diff
  stats: DiffStats;
}

export interface WorkflowRunMessagesResponse {
  messages: RunMessage[];
}

export interface SendInterventionRequest {
  message: string;
}

export interface SendInterventionResponse {
  messageId: string;
}

export interface CancelRunResponse {
  status: WorkflowRunStatus;
}

export interface RetryStageResponse {
  stageExecution: StageExecution;
}

export interface SkipStageResponse {
  nextStage: string | null;
  status: WorkflowRunStatus;
}

export interface ResolveConflictResponse {
  status: WorkflowRunStatus;
}

// ─── Reviews (SAD §8.2, SRD FR-R1–R11) ────────────────────────────────

export interface ReviewListQuery {
  runId?: string;
  stageName?: string;
  round?: number;
}

export interface ReviewListResponse {
  reviews: Review[];
}

export interface ReviewDetailResponse {
  review: Review;
  comments: ReviewComment[];
  stageExecution: StageExecution | null;
}

export interface ApproveReviewResponse {
  review: Review;
  nextStage: string | null;
  status: WorkflowRunStatus;
}

export interface RequestChangesRequest {
  comments: CreateReviewCommentRequest[];
}

export interface RequestChangesResponse {
  review: Review;
  stageExecution: StageExecution;
}

export interface CreateReviewCommentRequest {
  filePath?: string;
  lineNumber?: number;
  side?: 'left' | 'right';
  body: string;
}

export interface ReviewCommentsResponse {
  comments: ReviewComment[];
}

// ─── Proposals (SAD §8.2, SRD FR-S1–S6) ───────────────────────────────

export interface ProposalListQuery {
  runId?: string;
  status?: ProposalStatus;
}

export interface ProposalListResponse {
  proposals: Proposal[];
}

export interface ProposalDetailResponse {
  proposal: Proposal;
}

export interface UpdateProposalRequest {
  title?: string;
  description?: string;
  affectedFiles?: string[];
  dependsOn?: string[];
  sortOrder?: number;
  workflowTemplateOverride?: string | null;
}

export interface CreateProposalRequest {
  workflowRunId: string;
  stageName: string;
  title: string;
  description: string;
  affectedFiles?: string[];
  dependsOn?: string[];
  sortOrder?: number;
  workflowTemplateOverride?: string;
}

export interface LaunchProposalsRequest {
  proposalIds: string[];
}

export interface LaunchProposalsResponse {
  parallelGroup: ParallelGroup;
  childRuns: WorkflowRun[];
}

// ─── Parallel Groups (SAD §8.2, SRD FR-S7–S13) ────────────────────────

export interface ParallelGroupDetailResponse {
  group: ParallelGroup;
  children: WorkflowRun[];
  summary: {
    total: number;
    completed: number;
    failed: number;
    cancelled: number;
    running: number;
    pending: number;
  };
}

export interface ConsolidateResponse {
  review: Review;
}

export interface ConsolidatePartialResponse {
  review: Review;
  skippedChildIds: string[];
}

export interface RetryChildrenResponse {
  retriedRuns: WorkflowRun[];
}

export interface CancelGroupResponse {
  group: ParallelGroup;
  cancelledRuns: string[];
}

// ─── Credentials (SAD §8.2, SRD FR-C1–C8) ─────────────────────────────

export interface CreateCredentialSetRequest {
  name: string;
  description?: string;
  projectId?: string;
}

export interface UpdateCredentialSetRequest {
  name?: string;
  description?: string;
}

export interface CredentialSetListResponse {
  sets: CredentialSet[];
}

export interface CredentialSetDetailResponse {
  set: CredentialSet;
  entries: CredentialEntry[];                      // values always masked
}

export interface CreateCredentialEntryRequest {
  key: string;
  value?: string;                                  // plaintext — encrypted on server; optional for command_extract
  type: string;
  mountPath?: string;
  command?: string;
}

export interface UpdateCredentialEntryRequest {
  key?: string;
  value?: string;
  type?: string;
  mountPath?: string;
  command?: string;
}

export interface CredentialAuditResponse {
  entries: Array<{
    id: string;
    action: string;
    credentialSetId: string | null;
    credentialEntryId: string | null;
    workflowRunId: string | null;
    details: Record<string, unknown> | null;
    createdAt: string;
  }>;
  total: number;
}

// ─── Last Run Config ───────────────────────────────────────────────────

export interface LastRunConfigResponse {
  config: LastRunConfig;
}

// ─── Stats (SAD §8.1, SRD FR-D1–D3, CDD-api §11.1) ───────────────────

export interface RecentActivity {
  type: 'run_completed' | 'run_failed' | 'review_created' | 'run_started';
  runId: string;
  title: string | null;
  timestamp: string;
}

export interface WorkspaceSummaryResponse {
  running: number;                                 // workflow runs currently running
  pendingReviews: number;                          // reviews in pending_review status
  awaitingAction: number;                          // runs in stage_failed, awaiting_proposals, etc.
  recentActivity: RecentActivity[];
}

// ─── Health (SAD §10.7, SRD NFR-O3) ───────────────────────────────────

export interface HealthResponse {
  status: 'ok';
  version: string;
  uptime: number;
}

// ─── Prerequisite Checks (SAD §10.7, SRD NFR-I4) ──────────────────────

export interface PrerequisiteCheck {
  name: string;
  status: 'ok' | 'missing' | 'error';
  message: string;
  fixInstructions?: string;
}

export interface PrerequisitesResponse {
  checks: PrerequisiteCheck[];
  allPassed: boolean;
}
```

### 2.5 Barrel Export (`shared/types/index.ts`)

```typescript
// shared/types/index.ts

export * from './enums';
export * from './entities';
export * from './events';
export * from './api';
```

---

## 3. Zod Validation Schemas (`daemon/src/lib/validation/`)

Zod schemas for API request validation (SAD §10.1). Used in route handlers before
delegating to services.

### 3.1 Shared Validators (`daemon/src/lib/validation/shared.ts`)

```typescript
// daemon/src/lib/validation/shared.ts

import { z } from 'zod';

/**
 * Git ref validator — blocks injection characters (SAD §10.1, SRD NFR-S5).
 * Allows: a-z A-Z 0-9 . _ / -
 * Blocks: backticks, $, ;, |, <>, (), {}, \, newlines, ..
 * Also disallows: leading/trailing slashes, consecutive slashes.
 */
export const gitRefSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(
    /^[a-zA-Z0-9._-]([a-zA-Z0-9._\/-]*[a-zA-Z0-9._-])?$/,
    'Invalid git ref: must not start/end with slash, only alphanumerics, dots, underscores, slashes, and hyphens allowed',
  )
  .refine((val) => !val.includes('..'), 'Git ref must not contain ".."')
  .refine((val) => !val.includes('//'), 'Git ref must not contain consecutive slashes');

/** UUID string. */
export const uuidSchema = z.string().uuid();

/** Non-empty trimmed string. */
export const nonEmptyString = z.string().trim().min(1, 'Must not be empty');
```

### 3.2 Project Validators (`daemon/src/lib/validation/projects.ts`)

```typescript
// daemon/src/lib/validation/projects.ts

import { z } from 'zod';
import { nonEmptyString, uuidSchema } from './shared';

export const createProjectSchema = z.object({
  name: nonEmptyString.max(200),
  localPath: nonEmptyString.max(1024),
  gitUrl: z.string().url().optional(),
  description: z.string().max(2000).optional(),
  defaultCredentialSetId: uuidSchema.optional(),
});

export const updateProjectSchema = z.object({
  name: nonEmptyString.max(200).optional(),
  description: z.string().max(2000).optional(),
  defaultCredentialSetId: uuidSchema.nullable().optional(),
});

export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;
```

### 3.3 Agent Validators (`daemon/src/lib/validation/agents.ts`)

```typescript
// daemon/src/lib/validation/agents.ts

import { z } from 'zod';
import { nonEmptyString } from './shared';

const agentTypeEnum = z.enum(['copilot_cli']);
const outputFormatEnum = z.enum(['acp', 'jsonl', 'text']);

export const createAgentDefinitionSchema = z.object({
  name: nonEmptyString.max(200),
  type: agentTypeEnum,
  commandTemplate: nonEmptyString.max(2000),
  dockerImage: z.string().max(500).optional(),
  description: z.string().max(2000).optional(),
  supportsStreaming: z.boolean().optional().default(true),
  supportsContinue: z.boolean().optional().default(true),
  supportsIntervention: z.boolean().optional().default(true),
  outputFormat: outputFormatEnum.optional().default('acp'),
});

export const updateAgentDefinitionSchema = z.object({
  name: nonEmptyString.max(200).optional(),
  commandTemplate: nonEmptyString.max(2000).optional(),
  dockerImage: z.string().max(500).optional(),
  description: z.string().max(2000).optional(),
  supportsStreaming: z.boolean().optional(),
  supportsContinue: z.boolean().optional(),
  supportsIntervention: z.boolean().optional(),
  outputFormat: outputFormatEnum.optional(),
});

export type CreateAgentDefinitionInput = z.infer<typeof createAgentDefinitionSchema>;
export type UpdateAgentDefinitionInput = z.infer<typeof updateAgentDefinitionSchema>;
```

### 3.4 Workflow Template Validators (`daemon/src/lib/validation/workflows.ts`)

```typescript
// daemon/src/lib/validation/workflows.ts

import { z } from 'zod';
import { nonEmptyString } from './shared';

/** Single stage definition within a template (SRD FR-W2). */
const workflowStageSchema = z
  .object({
    name: nonEmptyString.max(100),
    type: z.enum(['standard', 'split']),
    promptTemplate: z.string().max(50_000),
    reviewRequired: z.boolean(),
    autoAdvance: z.boolean(),
    freshSession: z.boolean().default(false),
    model: z.string().max(100).optional(),         // per-stage model override (FR-W23)
    isFinal: z.boolean().optional(),
  })
  .refine(
    (stage) => stage.reviewRequired !== stage.autoAdvance,
    'reviewRequired and autoAdvance must be mutually exclusive (exactly one must be true)',
  );

export const createWorkflowTemplateSchema = z.object({
  name: nonEmptyString.max(200),
  description: z.string().max(2000).optional(),
  stages: z.array(workflowStageSchema).min(1, 'Template must have at least one stage'),
});

export const updateWorkflowTemplateSchema = z.object({
  name: nonEmptyString.max(200).optional(),
  description: z.string().max(2000).optional(),
  stages: z.array(workflowStageSchema).min(1).optional(),
});

export type CreateWorkflowTemplateInput = z.infer<typeof createWorkflowTemplateSchema>;
export type UpdateWorkflowTemplateInput = z.infer<typeof updateWorkflowTemplateSchema>;
```

### 3.5 Workflow Run Validators (`daemon/src/lib/validation/runs.ts`)

```typescript
// daemon/src/lib/validation/runs.ts

import { z } from 'zod';
import { gitRefSchema, nonEmptyString, uuidSchema } from './shared';

export const createWorkflowRunSchema = z.object({
  projectId: uuidSchema,
  workflowTemplateId: uuidSchema,
  agentDefinitionId: uuidSchema,
  description: nonEmptyString.max(10_000),
  credentialSetId: uuidSchema.optional(),
  baseBranch: gitRefSchema.optional(),
  targetBranch: gitRefSchema.optional(),
  title: z.string().max(200).optional(),
  model: z.string().max(100).optional(),           // run-level model override (FR-W23)
});

export const sendInterventionSchema = z.object({
  message: nonEmptyString.max(50_000),
});

export type CreateWorkflowRunInput = z.infer<typeof createWorkflowRunSchema>;
export type SendInterventionInput = z.infer<typeof sendInterventionSchema>;
```

### 3.6 Review Validators (`daemon/src/lib/validation/reviews.ts`)

```typescript
// daemon/src/lib/validation/reviews.ts

import { z } from 'zod';
import { nonEmptyString } from './shared';

const reviewCommentSchema = z.object({
  filePath: z.string().max(1024).optional(),
  lineNumber: z.number().int().positive().optional(),
  side: z.enum(['left', 'right']).optional(),
  body: nonEmptyString.max(10_000),
});

export const requestChangesSchema = z.object({
  comments: z.array(reviewCommentSchema).min(1, 'Must include at least one comment'),
});

export const createReviewCommentSchema = reviewCommentSchema;

export type RequestChangesInput = z.infer<typeof requestChangesSchema>;
export type CreateReviewCommentInput = z.infer<typeof createReviewCommentSchema>;
```

### 3.7 Proposal Validators (`daemon/src/lib/validation/proposals.ts`)

```typescript
// daemon/src/lib/validation/proposals.ts

import { z } from 'zod';
import { nonEmptyString, uuidSchema } from './shared';

export const createProposalSchema = z.object({
  workflowRunId: uuidSchema,
  stageName: nonEmptyString.max(100),
  title: nonEmptyString.max(500),
  description: nonEmptyString.max(50_000),
  affectedFiles: z.array(z.string().max(1024)).optional(),
  dependsOn: z.array(z.string().max(500)).optional(),
  sortOrder: z.number().int().min(0).optional().default(0),
  workflowTemplateOverride: uuidSchema.optional(),
});

export const updateProposalSchema = z.object({
  title: nonEmptyString.max(500).optional(),
  description: nonEmptyString.max(50_000).optional(),
  affectedFiles: z.array(z.string().max(1024)).optional(),
  dependsOn: z.array(z.string().max(500)).optional(),
  sortOrder: z.number().int().min(0).optional(),
  workflowTemplateOverride: uuidSchema.nullable().optional(),
});

export const launchProposalsSchema = z.object({
  proposalIds: z.array(uuidSchema).min(1, 'Must select at least one proposal'),
});

export type CreateProposalInput = z.infer<typeof createProposalSchema>;
export type UpdateProposalInput = z.infer<typeof updateProposalSchema>;
export type LaunchProposalsInput = z.infer<typeof launchProposalsSchema>;
```

### 3.8 Credential Validators (`daemon/src/lib/validation/credentials.ts`)

```typescript
// daemon/src/lib/validation/credentials.ts

import { z } from 'zod';
import { nonEmptyString, uuidSchema } from './shared';

export const createCredentialSetSchema = z.object({
  name: nonEmptyString.max(200),
  description: z.string().max(2000).optional(),
  projectId: uuidSchema.optional(),
});

export const updateCredentialSetSchema = z.object({
  name: nonEmptyString.max(200).optional(),
  description: z.string().max(2000).optional(),
});

const credentialEntryTypeEnum = z.enum([
  'env_var',
  'file_mount',
  'docker_login',
  'host_dir_mount',
  'command_extract',
]);

/**
 * Credential entry validator with type-specific refinements (SAD §6.2).
 *
 * - env_var:         key = env var name, value = env var value
 * - file_mount:      key = identifier, value = file content, mountPath required
 * - docker_login:    key = registry, value = JSON { username, password }
 * - host_dir_mount:  key = identifier, value = host path, mountPath required
 * - command_extract: key = env var name, value optional (empty string), command required
 */
export const createCredentialEntrySchema = z
  .object({
    key: nonEmptyString.max(500),
    value: z.string().max(1_000_000).optional().default(''), // optional for command_extract
    type: credentialEntryTypeEnum,
    mountPath: z.string().max(1024).optional(),
    command: z.string().max(2000).optional(),
  })
  .superRefine((entry, ctx) => {
    // value is required (non-empty) for all types except command_extract
    if (entry.type !== 'command_extract' && (!entry.value || entry.value.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `value is required for ${entry.type} entries`,
        path: ['value'],
      });
    }
    if ((entry.type === 'file_mount' || entry.type === 'host_dir_mount') && !entry.mountPath) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `mountPath is required for ${entry.type} entries`,
        path: ['mountPath'],
      });
    }
    if (entry.type === 'command_extract' && !entry.command) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'command is required for command_extract entries',
        path: ['command'],
      });
    }
    // docker_login value must be valid JSON with username and password
    if (entry.type === 'docker_login' && entry.value) {
      try {
        const parsed = JSON.parse(entry.value);
        if (typeof parsed.username !== 'string' || typeof parsed.password !== 'string') {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'docker_login value must be JSON with "username" and "password" string fields',
            path: ['value'],
          });
        }
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'docker_login value must be valid JSON: { "username": "...", "password": "..." }',
          path: ['value'],
        });
      }
    }
  });

export const updateCredentialEntrySchema = z
  .object({
    key: nonEmptyString.max(500).optional(),
    value: z.string().max(1_000_000).optional(),
    type: credentialEntryTypeEnum.optional(),
    mountPath: z.string().max(1024).optional(),
    command: z.string().max(2000).optional(),
  })
  .superRefine((entry, ctx) => {
    // When type is provided, validate type-specific constraints
    if (entry.type) {
      if ((entry.type === 'file_mount' || entry.type === 'host_dir_mount') && entry.mountPath === '') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `mountPath is required for ${entry.type} entries`,
          path: ['mountPath'],
        });
      }
      if (entry.type === 'command_extract' && entry.command === '') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'command is required for command_extract entries',
          path: ['command'],
        });
      }
      // docker_login JSON validation on update
      if (entry.type === 'docker_login' && entry.value) {
        try {
          const parsed = JSON.parse(entry.value);
          if (typeof parsed.username !== 'string' || typeof parsed.password !== 'string') {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: 'docker_login value must be JSON with "username" and "password" string fields',
              path: ['value'],
            });
          }
        } catch {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'docker_login value must be valid JSON: { "username": "...", "password": "..." }',
            path: ['value'],
          });
        }
      }
    }
  });

export type CreateCredentialSetInput = z.infer<typeof createCredentialSetSchema>;
export type UpdateCredentialSetInput = z.infer<typeof updateCredentialSetSchema>;
export type CreateCredentialEntryInput = z.infer<typeof createCredentialEntrySchema>;
export type UpdateCredentialEntryInput = z.infer<typeof updateCredentialEntrySchema>;
```

### 3.9 Validation Barrel (`daemon/src/lib/validation/index.ts`)

```typescript
// daemon/src/lib/validation/index.ts

export * from './shared';
export * from './projects';
export * from './agents';
export * from './workflows';
export * from './runs';
export * from './reviews';
export * from './proposals';
export * from './credentials';
```

---

## 4. Requirement Traceability

| SAD/SRD Reference | CDD Section | Implementation |
|---|---|---|
| SAD §4.2 `projects` | §1 `projects` table | Drizzle schema with FK to credentialSets; onDelete design note |
| SAD §4.2 `agentDefinitions` | §1 `agentDefinitions` table | Capability booleans, outputFormat enum, `isBuiltIn` for seed protection |
| SAD §4.2 `workflowTemplates` | §1 `workflowTemplates` table | JSON `stages` column with `WorkflowStage[]`, `isBuiltIn` for seed protection |
| SAD §4.2 `workflowRuns` | §1 `workflowRuns` table | All FKs, status indexes, parent/child links, CHECK invariant comments |
| SAD §4.2 `stageExecutions` | §1 `stageExecutions` table | UNIQUE(runId, stageName, round), CHECK invariant comments |
| SAD §4.2 `runMessages` | §1 `runMessages` table | ON DELETE CASCADE, session boundary marker |
| SAD §4.2 `reviews` | §1 `reviews` table | Sentinel `'__consolidation__'` for NULL-safe UNIQUE; UNIQUE(runId, stageName, round, type) |
| SAD §4.2 `reviewComments` | §1 `reviewComments` table | ON DELETE CASCADE from reviews |
| SAD §4.2 `proposals` | §1 `proposals` table | UNIQUE(runId, stageName, title), parallelGroupId FK onDelete: set null |
| SAD §4.2 `parallelGroups` | §1 `parallelGroups` table | Status enum, completedAt |
| SAD §4.2 `credentialSets` | §1 `credentialSets` table | ON DELETE SET NULL for projectId |
| SAD §4.2 `credentialEntries` | §1 `credentialEntries` table | ON DELETE CASCADE, value default '' for command_extract, updatedAt added, CHECK comments |
| SAD §4.2 `credentialAuditLog` | §1 `credentialAuditLog` table | Indexed by set and run |
| SAD §4.2 `lastRunConfig` | §1 `lastRunConfig` table | Singleton (id=1), CHECK(id=1) comment for raw migration |
| SAD §4.2 `hookResumes` | §1 `hookResumes` table | UNIQUE hookToken, outbox pattern, action as JSON |
| SAD §4.2 `gitOperations` | §1 `gitOperations` table | UNIQUE(runId, type), phase journal |
| SAD §4.3 Status enums | §2.1 `enums.ts` | Const objects + extracted union types, StageFailureReason typed |
| SAD §3.2 WebSocket protocol | §2.3 `events.ts` | ClientMessage / ServerMessage unions, connected/ping/pong/proposals_ready/conflict_detected added |
| SAD §8.2 API patterns | §2.4 `api.ts` | WorkflowRunSummary with denormalized names, DiffFile[]/DiffStats, WorkspaceSummaryResponse reconciled |
| SAD §6.2 Credential types | §2.2 TypedCredentialEntry | Discriminated union by type, command_extract value optional |
| SAD §10.1 Input validation | §3 Zod schemas | Tightened gitRefSchema, docker_login JSON validation, update schema with superRefine |
| SRD FR-W2 Stage definition | §3.4 workflowStageSchema | reviewRequired ⊕ autoAdvance refinement |
| SRD FR-C2 Credential types | §3.8 createCredentialEntrySchema | mountPath/command/value conditional requirements |
| SRD NFR-S5 Injection prevention | §3.1 gitRefSchema | Allowlist regex, `..` blocked, no leading/trailing/consecutive slashes |
| SRD FR-C7 Value masking | §2.2 CredentialEntry vs WithValue | API type excludes `value` field |
| CDD-api §11.1 Stats | §2.4 WorkspaceSummaryResponse | running, pendingReviews, awaitingAction, recentActivity[] |
| CDD-api §12 WebSocket | §2.3 events.ts | stageName (not stage), round, connected, pong, proposals_ready, conflict_detected |
