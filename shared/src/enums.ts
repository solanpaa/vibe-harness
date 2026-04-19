// Status enums from CDD-schema.md §2.1
// Defined as const objects + extracted types for runtime validation
// and exhaustive switch checking.

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

// ─── Workflow stage type (REMOVED — see splittable on WorkflowStage) ───
// StageType enum was removed when ad-hoc split execution replaced the
// predeclared `type: 'split'` model. Stages now opt in via `splittable`.
