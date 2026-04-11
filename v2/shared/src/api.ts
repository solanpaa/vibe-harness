// API request/response types from CDD-schema.md §2.4

import type {
  Project, AgentDefinition, WorkflowTemplate, WorkflowRun,
  StageExecution, RunMessage, Review, ReviewComment, Proposal,
  ParallelGroup, CredentialSet, CredentialEntry, LastRunConfig,
  WorkflowStage, DiffFile, DiffStats,
} from './entities';
import type {
  WorkflowRunStatus, ProposalStatus,
} from './enums';

// ─── Standard error response ───────────────────────────────────────────

export interface ApiError {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

// ─── Projects ──────────────────────────────────────────────────────────

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

export interface BranchInfo {
  name: string;
  isCurrent: boolean;
  isRemote: boolean;
  lastCommit: string | null;
}

export interface ProjectBranchesResponse {
  branches: BranchInfo[];
  currentBranch: string | null;
}

// ─── Agents ────────────────────────────────────────────────────────────

export interface CreateAgentDefinitionRequest {
  name: string;
  type: string;
  commandTemplate: string;
  dockerImage?: string;
  dockerfile?: string;
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
  dockerfile?: string;
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

// ─── Workflow Templates ────────────────────────────────────────────────

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

// ─── Workflow Runs ─────────────────────────────────────────────────────

export interface CreateWorkflowRunRequest {
  projectId: string;
  workflowTemplateId: string;
  agentDefinitionId: string;
  description: string;
  credentialSetId?: string;
  baseBranch?: string;
  targetBranch?: string;
  title?: string;
  model?: string;
  attachments?: Array<{
    name: string;
    type: string;
    dataUrl: string;
  }>;
}

export interface WorkflowRunListQuery {
  status?: WorkflowRunStatus | WorkflowRunStatus[];
  projectId?: string;
  parentRunId?: string;
}

export interface WorkflowRunSummary {
  id: string;
  title: string | null;
  description: string | null;
  status: WorkflowRunStatus;
  currentStage: string | null;
  projectId: string;
  projectName: string;
  workflowTemplateName: string;
  branch: string | null;
  parentRunId: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface WorkflowRunListResponse {
  runs: WorkflowRunSummary[];
  total: number;
}

export interface StageExecutionDetail extends StageExecution {
  reviewId: string | null;
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
  activeReviewId: string | null;
  childRunIds: string[];
}

// ─── Diff types (shared between runs and reviews) ──────────────────────
// The API returns the full structured diff from entities.ts: DiffFile[]
// with hunks containing individual DiffLines (add/delete/context).
// An earlier CDD draft had a simplified DiffChunk shape — that was removed.

export interface WorkflowRunDiffResponse {
  diff: string;
  files: DiffFile[];
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

// ─── Reviews ───────────────────────────────────────────────────────────

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

// ─── Proposals ─────────────────────────────────────────────────────────

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

// ─── Parallel Groups ───────────────────────────────────────────────────

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

// ─── Run Result ────────────────────────────────────────────────────────

export interface RunResultFileChange {
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  path: string;
}

export interface RunResultResponse {
  commitHash: string | null;
  commitMessage: string | null;
  branch: string | null;
  targetBranch: string | null;
  completedAt: string | null;
  filesChanged: RunResultFileChange[];
  diffStat: string | null;
}

// ─── Credentials ───────────────────────────────────────────────────────

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
  entries: CredentialEntry[];
}

export interface CreateCredentialEntryRequest {
  key: string;
  value?: string;
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

// ─── Stats ─────────────────────────────────────────────────────────────

export interface RecentActivity {
  type: 'run_completed' | 'run_failed' | 'review_created' | 'run_started';
  runId: string;
  title: string | null;
  timestamp: string;
}

export interface WorkspaceSummaryResponse {
  running: number;
  pendingReviews: number;
  awaitingAction: number;
  recentActivity: RecentActivity[];
}

// ─── Health ────────────────────────────────────────────────────────────

export interface HealthResponse {
  status: 'ok';
  version: string;
  uptime: number;
}

// ─── Prerequisite Checks ───────────────────────────────────────────────

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
