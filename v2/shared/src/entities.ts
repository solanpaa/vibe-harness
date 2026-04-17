// Entity types from CDD-schema.md §2.2
// Match DB schema but with parsed JSON fields.
// These are what services return and routes serialize.

import type {
  WorkflowRunStatus, StageStatus, StageFailureReason, ReviewType, ReviewStatus,
  ParallelGroupStatus, ProposalStatus, CredentialEntryType,
  MessageRole, AgentOutputFormat, AgentType, DiffSide,
  GitOperationType, GitOperationPhase,
} from './enums';

// ─── Workflow stage template (JSON inside workflowTemplates.stages) ────

export interface WorkflowStage {
  name: string;
  /**
   * When true, the stage's review screen exposes a "Split" action that
   * launches the ad-hoc split sub-pipeline (splitter agent → proposals →
   * children → consolidate → consolidation review → global post-split
   * stages → finalize). Defaults to false.
   */
  splittable?: boolean;
  promptTemplate: string;
  reviewRequired: boolean;
  autoAdvance: boolean;
  freshSession: boolean;
  model?: string;
  isFinal?: boolean;
}

// ─── Split execution snapshot (resolved at decision time, persisted on
// workflow_runs.split_config_json AND embedded in the review hook resume
// payload — see plan §"Why snapshot") ───────────────────────────────────

export interface SplitConfigSnapshot {
  sourceStageName: string;
  sourceReviewId: string;
  triggeredAt: string;
  splitterPromptTemplate: string;
  extraDescription: string;
  effectiveSplitterPrompt: string;
  postSplitStages: WorkflowStage[];
  skippedTemplateStages: string[];
}

// ─── Global app settings (settings table, key/value, typed parsers) ────

export const AppSettingKey = {
  DefaultSplitterPromptTemplate: 'defaultSplitterPromptTemplate',
  DefaultPostSplitStages: 'defaultPostSplitStages',
} as const;

export type AppSettingKey = (typeof AppSettingKey)[keyof typeof AppSettingKey];

export interface AppSettings {
  defaultSplitterPromptTemplate: string;
  defaultPostSplitStages: WorkflowStage[];
}

// ─── projects ──────────────────────────────────────────────────────────

export interface Project {
  id: string;
  name: string;
  gitUrl: string | null;
  localPath: string;
  description: string | null;
  defaultCredentialSetId: string | null;
  ghAccount: string | null;
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
  dockerfile: string | null;
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
  stages: WorkflowStage[];
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
  model: string | null;
  ghAccount: string | null;
  /**
   * Snapshot captured the first time the user clicked "Split" on a review
   * for this run. Read-only after first write. Null for non-split runs.
   */
  splitConfig: SplitConfigSnapshot | null;
  createdAt: string;
  completedAt: string | null;
}

// ─── stageExecutions ───────────────────────────────────────────────────

export interface UsageStats {
  tokens?: number;
  durationMs?: number;
  cost?: number;
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
  model: string | null;
  startedAt: string | null;
  completedAt: string | null;
  failureReason: StageFailureReason | null;
  usageStats: UsageStats | null;
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
  metadata: RunMessageMetadata | null;
  createdAt: string;
}

// ─── reviews ───────────────────────────────────────────────────────────

export const CONSOLIDATION_STAGE_SENTINEL = '__consolidation__' as const;

export interface Review {
  id: string;
  workflowRunId: string;
  stageName: string | null;
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
  affectedFiles: string[] | null;
  dependsOn: string[] | null;
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

/** Internal-only: includes the decrypted value. NEVER returned from API routes. */
export interface CredentialEntryWithValue extends CredentialEntry {
  value: string;
}

export interface EnvVarCredential {
  type: 'env_var';
  key: string;
  value: string;
}

export interface FileMountCredential {
  type: 'file_mount';
  key: string;
  value: string;
  mountPath: string;
}

export interface DockerLoginCredential {
  type: 'docker_login';
  key: string;
  value: string;
}

export interface HostDirMountCredential {
  type: 'host_dir_mount';
  key: string;
  value: string;
  mountPath: string;
}

export interface CommandExtractCredential {
  type: 'command_extract';
  key: string;
  command: string;
  value?: undefined;
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
  details: Record<string, unknown> | null;
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
  action: Record<string, unknown>;
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
  metadata: GitOperationMetadata | null;
  createdAt: string;
  updatedAt: string;
}

// ─── Diff types (from CDD-services §10.1) ─────────────────────────────

export type DiffLineType = 'add' | 'delete' | 'context';

export interface DiffLine {
  type: DiffLineType;
  content: string;
  oldLineNumber: number | null;
  newLineNumber: number | null;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  context?: string;
  lines: DiffLine[];
}

export type DiffFileStatus = 'added' | 'deleted' | 'modified' | 'renamed';

export interface DiffFile {
  oldPath: string | null;
  newPath: string | null;
  status: DiffFileStatus;
  isBinary: boolean;
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
}

export interface DiffStats {
  filesChanged: number;
  additions: number;
  deletions: number;
}
