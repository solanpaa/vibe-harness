import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

// ── Projects ───────────────────────────────────────────────────────

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  gitUrl: text("git_url"),
  localPath: text("local_path").notNull(),
  description: text("description"),
  defaultCredentialSetId: text("default_credential_set_id"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// ── Subprojects ────────────────────────────────────────────────────

export const subprojects = sqliteTable("subprojects", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  pathFilter: text("path_filter"),
  createdAt: text("created_at").notNull(),
});

// ── Agent Definitions ──────────────────────────────────────────────

export const agentDefinitions = sqliteTable("agent_definitions", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  type: text("type").notNull(), // copilot_cli | claude_code | codex | aider | custom
  commandTemplate: text("command_template").notNull(),
  dockerImage: text("docker_image"),
  description: text("description"),
  createdAt: text("created_at").notNull(),
});

// ── Credential Sets ────────────────────────────────────────────────

export const credentialSets = sqliteTable("credential_sets", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  projectId: text("project_id").references(() => projects.id, {
    onDelete: "set null",
  }),
  createdAt: text("created_at").notNull(),
});

// ── Credential Entries ─────────────────────────────────────────────

export const credentialEntries = sqliteTable("credential_entries", {
  id: text("id").primaryKey(),
  credentialSetId: text("credential_set_id")
    .notNull()
    .references(() => credentialSets.id, { onDelete: "cascade" }),
  key: text("key").notNull(),
  value: text("value").notNull(), // encrypted
  type: text("type").notNull(), // env_var | file_mount | docker_login
  createdAt: text("created_at").notNull(),
});

// ── Workflow Templates ─────────────────────────────────────────────

export const workflowTemplates = sqliteTable("workflow_templates", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  stages: text("stages").notNull(), // JSON string of WorkflowStage[]
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// ── Workflow Runs ──────────────────────────────────────────────────

export const workflowRuns = sqliteTable("workflow_runs", {
  id: text("id").primaryKey(),
  workflowTemplateId: text("workflow_template_id")
    .notNull()
    .references(() => workflowTemplates.id),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id),
  subprojectId: text("subproject_id").references(() => subprojects.id),
  status: text("status").notNull().default("pending"),
  currentStage: text("current_stage"),
  createdAt: text("created_at").notNull(),
  completedAt: text("completed_at"),
});

// ── Sessions ───────────────────────────────────────────────────────

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id),
  subprojectId: text("subproject_id").references(() => subprojects.id),
  workflowRunId: text("workflow_run_id").references(() => workflowRuns.id),
  stageName: text("stage_name"),
  agentDefinitionId: text("agent_definition_id")
    .notNull()
    .references(() => agentDefinitions.id),
  credentialSetId: text("credential_set_id").references(
    () => credentialSets.id
  ),
  sandboxId: text("sandbox_id"),
  status: text("status").notNull().default("pending"),
  prompt: text("prompt").notNull(),
  model: text("model"),
  useWorktree: integer("use_worktree").notNull().default(1), // 1=true, 0=false
  output: text("output"),
  createdAt: text("created_at").notNull(),
  completedAt: text("completed_at"),
});

// ── Reviews ────────────────────────────────────────────────────────

export const reviews = sqliteTable("reviews", {
  id: text("id").primaryKey(),
  workflowRunId: text("workflow_run_id").references(() => workflowRuns.id),
  sessionId: text("session_id")
    .notNull()
    .references(() => sessions.id),
  round: integer("round").notNull().default(1),
  status: text("status").notNull().default("pending_review"),
  aiSummary: text("ai_summary"),
  diffSnapshot: text("diff_snapshot"),
  createdAt: text("created_at").notNull(),
});

// ── Review Comments ────────────────────────────────────────────────

export const reviewComments = sqliteTable("review_comments", {
  id: text("id").primaryKey(),
  reviewId: text("review_id")
    .notNull()
    .references(() => reviews.id, { onDelete: "cascade" }),
  filePath: text("file_path").notNull(),
  lineNumber: integer("line_number"),
  side: text("side"), // left | right
  body: text("body").notNull(),
  createdAt: text("created_at").notNull(),
});
