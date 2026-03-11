import { z } from "zod";

// ── Agent Definitions ──────────────────────────────────────────────

export const AgentType = z.enum([
  "copilot_cli",
  "claude_code",
  "codex",
  "aider",
  "custom",
]);
export type AgentType = z.infer<typeof AgentType>;

export const AgentDefinitionSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  type: AgentType,
  commandTemplate: z.string(),
  dockerImage: z.string().optional(),
  description: z.string().optional(),
  createdAt: z.string().datetime(),
});
export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;

// ── Projects ───────────────────────────────────────────────────────

export const ProjectSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  gitUrl: z.string().optional(),
  localPath: z.string().min(1),
  description: z.string().optional(),
  defaultCredentialSetId: z.string().uuid().optional().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Project = z.infer<typeof ProjectSchema>;

export const CreateProjectSchema = z.object({
  name: z.string().min(1),
  gitUrl: z.string().optional(),
  localPath: z.string().min(1),
  description: z.string().optional(),
  defaultCredentialSetId: z.string().uuid().optional().nullable(),
});
export type CreateProject = z.infer<typeof CreateProjectSchema>;

// ── Credentials ────────────────────────────────────────────────────

export const CredentialEntryType = z.enum([
  "env_var",
  "file_mount",
  "docker_login",
]);
export type CredentialEntryType = z.infer<typeof CredentialEntryType>;

export const CredentialSetSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  description: z.string().optional(),
  projectId: z.string().uuid().optional().nullable(),
  createdAt: z.string().datetime(),
});
export type CredentialSet = z.infer<typeof CredentialSetSchema>;

export const CredentialEntrySchema = z.object({
  id: z.string().uuid(),
  credentialSetId: z.string().uuid(),
  key: z.string().min(1),
  value: z.string(), // encrypted at rest
  type: CredentialEntryType,
  createdAt: z.string().datetime(),
});
export type CredentialEntry = z.infer<typeof CredentialEntrySchema>;

// ── Workflow Templates ─────────────────────────────────────────────

export const WorkflowStageSchema = z.object({
  name: z.string().min(1),
  agentDefinitionId: z.string().uuid().optional(),
  promptTemplate: z.string(),
  autoAdvance: z.boolean().default(false),
  reviewRequired: z.boolean().default(true),
});
export type WorkflowStage = z.infer<typeof WorkflowStageSchema>;

export const WorkflowTemplateSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  description: z.string().optional(),
  stages: z.array(WorkflowStageSchema),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type WorkflowTemplate = z.infer<typeof WorkflowTemplateSchema>;

// ── Tasks ───────────────────────────────────────────────────────

export const TaskStatus = z.enum([
  "pending",
  "running",
  "paused",
  "awaiting_review",
  "completed",
  "failed",
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const TaskSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  workflowRunId: z.string().uuid().optional().nullable(),
  stageName: z.string().optional().nullable(),
  agentDefinitionId: z.string().uuid(),
  credentialSetId: z.string().uuid().optional().nullable(),
  sandboxId: z.string().optional().nullable(),
  originTaskId: z.string().uuid().optional().nullable(),
  status: TaskStatus,
  prompt: z.string(),
  output: z.string().optional(),
  createdAt: z.string().datetime(),
  completedAt: z.string().datetime().optional().nullable(),
});
export type Task = z.infer<typeof TaskSchema>;

export const CreateTaskSchema = z.object({
  projectId: z.string().uuid(),
  agentDefinitionId: z.string().uuid(),
  credentialSetId: z.string().uuid().optional().nullable(),
  prompt: z.string().min(1),
});
export type CreateTask = z.infer<typeof CreateTaskSchema>;

// ── Workflow Runs ──────────────────────────────────────────────────

export const WorkflowRunStatus = z.enum([
  "pending",
  "running",
  "awaiting_review",
  "completed",
  "failed",
]);
export type WorkflowRunStatus = z.infer<typeof WorkflowRunStatus>;

export const WorkflowRunSchema = z.object({
  id: z.string().uuid(),
  workflowTemplateId: z.string().uuid(),
  projectId: z.string().uuid(),
  taskDescription: z.string().optional().nullable(),
  status: WorkflowRunStatus,
  currentStage: z.string().optional().nullable(),
  createdAt: z.string().datetime(),
  completedAt: z.string().datetime().optional().nullable(),
});
export type WorkflowRun = z.infer<typeof WorkflowRunSchema>;

// ── Reviews ────────────────────────────────────────────────────────

export const ReviewStatus = z.enum([
  "pending_review",
  "changes_requested",
  "approved",
]);
export type ReviewStatus = z.infer<typeof ReviewStatus>;

export const ReviewSchema = z.object({
  id: z.string().uuid(),
  workflowRunId: z.string().uuid().optional().nullable(),
  taskId: z.string().uuid(),
  round: z.number().int().min(1),
  status: ReviewStatus,
  aiSummary: z.string().optional().nullable(),
  diffSnapshot: z.string().optional().nullable(),
  createdAt: z.string().datetime(),
});
export type Review = z.infer<typeof ReviewSchema>;

// ── Review Comments ────────────────────────────────────────────────

export const ReviewCommentSchema = z.object({
  id: z.string().uuid(),
  reviewId: z.string().uuid(),
  filePath: z.string(),
  lineNumber: z.number().int().optional().nullable(),
  side: z.enum(["left", "right"]).optional().nullable(),
  body: z.string().min(1),
  createdAt: z.string().datetime(),
});
export type ReviewComment = z.infer<typeof ReviewCommentSchema>;

export const CreateReviewCommentSchema = z.object({
  reviewId: z.string().uuid(),
  filePath: z.string(),
  lineNumber: z.number().int().optional().nullable(),
  side: z.enum(["left", "right"]).optional().nullable(),
  body: z.string().min(1),
});
export type CreateReviewComment = z.infer<typeof CreateReviewCommentSchema>;
