import { getDb, schema } from "@/lib/db";
import { eq, desc } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { startTask } from "./task-manager";
import { generateTitle } from "@/lib/services/title-generator";
import type { WorkflowStage } from "@/types/domain";

/**
 * Build a combined prompt from the task description and stage instructions.
 * When previousPlan is provided (fresh-session stages), it's injected as
 * context so the agent has the plan from the previous stage without
 * carrying over the full conversation history.
 */
function buildStagePrompt(
  taskDescription: string,
  stage: WorkflowStage,
  previousPlan?: string | null
): string {
  const parts = [`## Task`, taskDescription, ``];
  if (previousPlan) {
    parts.push(`## Context from Previous Stage`, previousPlan, ``);
  }
  parts.push(`## Current Stage: ${stage.name}`, stage.promptTemplate);
  return parts.join("\n");
}

/**
 * Create a workflow template with stages.
 */
export function createWorkflowTemplate(input: {
  name: string;
  description?: string;
  stages: WorkflowStage[];
}) {
  const db = getDb();
  const now = new Date().toISOString();
  const template = {
    id: uuid(),
    name: input.name,
    description: input.description || null,
    stages: JSON.stringify(input.stages),
    createdAt: now,
    updatedAt: now,
  };
  db.insert(schema.workflowTemplates).values(template).run();
  return { ...template, stages: input.stages };
}

/**
 * Start a workflow run — executes the first stage.
 * taskDescription is the user's high-level feature/task description.
 */
export async function startWorkflowRun(input: {
  workflowTemplateId: string;
  projectId: string;
  taskDescription: string;
  agentDefinitionId?: string | null;
  credentialSetId?: string | null;
  model?: string | null;
  useWorktree?: boolean;
}) {
  const db = getDb();

  // Get the template
  const template = db
    .select()
    .from(schema.workflowTemplates)
    .where(eq(schema.workflowTemplates.id, input.workflowTemplateId))
    .get();

  if (!template) throw new Error("Workflow template not found");

  const stages: WorkflowStage[] = JSON.parse(template.stages);
  if (stages.length === 0) throw new Error("Workflow has no stages");

  const firstStage = stages[0];
  const now = new Date().toISOString();

  // Create workflow run with task description
  const runId = uuid();
  db.insert(schema.workflowRuns)
    .values({
      id: runId,
      workflowTemplateId: template.id,
      projectId: input.projectId,
      taskDescription: input.taskDescription,
      status: "running",
      currentStage: firstStage.name,
      createdAt: now,
      completedAt: null,
    })
    .run();

  // Fire-and-forget title generation for the workflow run
  if (input.taskDescription) {
    generateTitle(input.taskDescription).then((title) => {
      if (title) {
        db.update(schema.workflowRuns)
          .set({ title })
          .where(eq(schema.workflowRuns.id, runId))
          .run();
      }
    }).catch(() => {});
  }

  // Get the project for the local path
  const project = db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, input.projectId))
    .get();

  if (!project) throw new Error("Project not found");

  // Get agent — use provided, stage-specific, or first available
  const agentId = input.agentDefinitionId || firstStage.agentDefinitionId;
  const agent = agentId
    ? db
        .select()
        .from(schema.agentDefinitions)
        .where(eq(schema.agentDefinitions.id, agentId))
        .get()
    : db.select().from(schema.agentDefinitions).get();

  if (!agent) throw new Error("No agent definition found");

  // Build combined prompt: task description + stage instructions
  const prompt = buildStagePrompt(input.taskDescription, firstStage);

  // Create and start task for the first stage
  const taskId = uuid();
  db.insert(schema.tasks)
    .values({
      id: taskId,
      projectId: input.projectId,
      workflowRunId: runId,
      stageName: firstStage.name,
      agentDefinitionId: agent.id,
      credentialSetId: input.credentialSetId || null,
      sandboxId: null,
      status: "pending",
      prompt,
      model: input.model || null,
      useWorktree: input.useWorktree !== false ? 1 : 0,
      output: null,
      createdAt: now,
      completedAt: null,
    })
    .run();

  // Fire-and-forget title generation for the task
  generateTitle(input.taskDescription).then((title) => {
    if (title) {
      db.update(schema.tasks)
        .set({ title })
        .where(eq(schema.tasks.id, taskId))
        .run();
    }
  }).catch(() => {});

  const agentCommand = agent.commandTemplate || "copilot";

  startTask({
    taskId,
    projectDir: project.localPath,
    agentCommand,
    credentialSetId: input.credentialSetId,
    prompt,
    model: input.model,
    useWorktree: input.useWorktree,
  });

  return { runId, taskId, stageName: firstStage.name };
}

/**
 * Advance a workflow to the next stage after a review is approved.
 * Uses --continue to preserve agent context across stages.
 */
export async function advanceWorkflow(workflowRunId: string): Promise<{
  completed: boolean;
  nextStage?: string;
  taskId?: string;
} | null> {
  const db = getDb();

  const run = db
    .select()
    .from(schema.workflowRuns)
    .where(eq(schema.workflowRuns.id, workflowRunId))
    .get();

  if (!run) return null;

  const template = db
    .select()
    .from(schema.workflowTemplates)
    .where(eq(schema.workflowTemplates.id, run.workflowTemplateId))
    .get();

  if (!template) return null;

  const stages: WorkflowStage[] = JSON.parse(template.stages);
  const currentIdx = stages.findIndex((s) => s.name === run.currentStage);

  if (currentIdx === -1 || currentIdx >= stages.length - 1) {
    // All stages done — mark as finalizing (finalize task will set "completed")
    db.update(schema.workflowRuns)
      .set({
        status: "finalizing",
        currentStage: "finalize",
      })
      .where(eq(schema.workflowRuns.id, workflowRunId))
      .run();
    return { completed: true };
  }

  const nextStage = stages[currentIdx + 1];
  const project = db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, run.projectId))
    .get();

  if (!project) return null;

  // Find the FIRST task in this workflow run (the origin) for --continue
  const firstTask = db
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.workflowRunId, workflowRunId))
    .all()
    .filter((t) => !t.originTaskId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];

  if (!firstTask) return null;

  const agent = nextStage.agentDefinitionId
    ? db
        .select()
        .from(schema.agentDefinitions)
        .where(eq(schema.agentDefinitions.id, nextStage.agentDefinitionId))
        .get()
    : db
        .select()
        .from(schema.agentDefinitions)
        .where(eq(schema.agentDefinitions.id, firstTask.agentDefinitionId))
        .get();

  if (!agent) return null;

  // For fresh-session stages, retrieve the plan from the most recent review
  // so the agent gets context without the full conversation history.
  const isFreshSession = nextStage.freshSession === true;
  let previousPlan: string | null = null;

  if (isFreshSession) {
    const latestReview = db
      .select()
      .from(schema.reviews)
      .where(eq(schema.reviews.workflowRunId, workflowRunId))
      .orderBy(desc(schema.reviews.createdAt))
      .limit(1)
      .get();

    // Find the task that produced this review for its lastAiMessage fallback
    const reviewTask = latestReview
      ? db
          .select({ lastAiMessage: schema.tasks.lastAiMessage })
          .from(schema.tasks)
          .where(eq(schema.tasks.id, latestReview.taskId))
          .get()
      : null;

    previousPlan =
      latestReview?.planMarkdown ||
      latestReview?.aiSummary ||
      reviewTask?.lastAiMessage ||
      null;
  }

  const prompt = buildStagePrompt(
    run.taskDescription || firstTask.prompt,
    nextStage,
    previousPlan
  );

  const now = new Date().toISOString();
  const taskId = uuid();

  db.insert(schema.tasks)
    .values({
      id: taskId,
      projectId: run.projectId,
      workflowRunId,
      stageName: nextStage.name,
      agentDefinitionId: agent.id,
      credentialSetId: firstTask.credentialSetId,
      sandboxId: null,
      originTaskId: firstTask.id,
      status: "pending",
      prompt,
      model: firstTask.model,
      useWorktree: firstTask.useWorktree,
      output: null,
      createdAt: now,
      completedAt: null,
    })
    .run();

  db.update(schema.workflowRuns)
    .set({ currentStage: nextStage.name, status: "running" })
    .where(eq(schema.workflowRuns.id, workflowRunId))
    .run();

  const agentCommand = agent.commandTemplate || "copilot";

  startTask({
    taskId,
    projectDir: project.localPath,
    agentCommand,
    credentialSetId: firstTask.credentialSetId,
    prompt,
    model: firstTask.model,
    useWorktree: firstTask.useWorktree === 1,
    isContinuation: !isFreshSession,
    originTaskId: firstTask.id,
  });

  return { completed: false, nextStage: nextStage.name, taskId };
}

/**
 * Look up the WorkflowStage config for a given workflow run and stage name.
 * Returns null for standalone tasks (no workflow) or if the stage isn't found.
 */
export function getStageConfig(
  workflowRunId: string,
  stageName: string
): WorkflowStage | null {
  const db = getDb();

  const run = db
    .select()
    .from(schema.workflowRuns)
    .where(eq(schema.workflowRuns.id, workflowRunId))
    .get();
  if (!run) return null;

  const template = db
    .select()
    .from(schema.workflowTemplates)
    .where(eq(schema.workflowTemplates.id, run.workflowTemplateId))
    .get();
  if (!template) return null;

  const stages: WorkflowStage[] = JSON.parse(template.stages);
  return stages.find((s) => s.name === stageName) ?? null;
}

/** Get default workflow template (plan → implement → review → done) */
export function getDefaultWorkflowStages(): WorkflowStage[] {
  return [
    {
      name: "plan",
      promptTemplate:
        "Analyze the codebase and create a detailed implementation plan for the requested changes. Do not make any code changes yet.",
      autoAdvance: false,
      reviewRequired: true,
      freshSession: false,
    },
    {
      name: "implement",
      promptTemplate:
        "Implement the changes according to the approved plan. Write clean, well-tested code.",
      autoAdvance: false,
      reviewRequired: true,
      freshSession: false,
    },
    {
      name: "review",
      promptTemplate:
        "Review the implementation for bugs, edge cases, performance issues, and code quality. Suggest improvements.",
      autoAdvance: false,
      reviewRequired: true,
      freshSession: false,
    },
  ];
}
