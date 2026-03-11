import { getDb, schema } from "@/lib/db";
import { eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { startSession } from "./session-manager";
import { createReviewForSession } from "./review-service";
import type { WorkflowStage } from "@/types/domain";

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
 */
export async function startWorkflowRun(input: {
  workflowTemplateId: string;
  projectId: string;
  subprojectId?: string | null;
  credentialSetId?: string | null;
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

  // Create workflow run
  const runId = uuid();
  db.insert(schema.workflowRuns)
    .values({
      id: runId,
      workflowTemplateId: template.id,
      projectId: input.projectId,
      subprojectId: input.subprojectId || null,
      status: "running",
      currentStage: firstStage.name,
      createdAt: now,
      completedAt: null,
    })
    .run();

  // Get the project for the local path
  const project = db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, input.projectId))
    .get();

  if (!project) throw new Error("Project not found");

  // Get default agent
  const agent = firstStage.agentDefinitionId
    ? db
        .select()
        .from(schema.agentDefinitions)
        .where(eq(schema.agentDefinitions.id, firstStage.agentDefinitionId))
        .get()
    : db.select().from(schema.agentDefinitions).get();

  if (!agent) throw new Error("No agent definition found");

  // Create and start session for the first stage
  const sessionId = uuid();
  db.insert(schema.sessions)
    .values({
      id: sessionId,
      projectId: input.projectId,
      subprojectId: input.subprojectId || null,
      workflowRunId: runId,
      stageName: firstStage.name,
      agentDefinitionId: agent.id,
      credentialSetId: input.credentialSetId || null,
      sandboxId: null,
      status: "pending",
      prompt: firstStage.promptTemplate,
      output: null,
      createdAt: now,
      completedAt: null,
    })
    .run();

  const agentCommand =
    agent.commandTemplate || "claude";

  startSession({
    sessionId,
    projectDir: project.localPath,
    agentCommand,
    credentialSetId: input.credentialSetId,
    prompt: firstStage.promptTemplate,
  });

  return { runId, sessionId, stageName: firstStage.name };
}

/**
 * Advance a workflow to the next stage after a review is approved.
 */
export async function advanceWorkflow(workflowRunId: string): Promise<{
  completed: boolean;
  nextStage?: string;
  sessionId?: string;
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
    // Workflow complete
    db.update(schema.workflowRuns)
      .set({
        status: "completed",
        completedAt: new Date().toISOString(),
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

  const agent = nextStage.agentDefinitionId
    ? db
        .select()
        .from(schema.agentDefinitions)
        .where(eq(schema.agentDefinitions.id, nextStage.agentDefinitionId))
        .get()
    : db.select().from(schema.agentDefinitions).get();

  if (!agent) return null;

  const now = new Date().toISOString();
  const sessionId = uuid();

  db.insert(schema.sessions)
    .values({
      id: sessionId,
      projectId: run.projectId,
      subprojectId: run.subprojectId,
      workflowRunId,
      stageName: nextStage.name,
      agentDefinitionId: agent.id,
      credentialSetId: null,
      sandboxId: null,
      status: "pending",
      prompt: nextStage.promptTemplate,
      output: null,
      createdAt: now,
      completedAt: null,
    })
    .run();

  db.update(schema.workflowRuns)
    .set({ currentStage: nextStage.name })
    .where(eq(schema.workflowRuns.id, workflowRunId))
    .run();

  const agentCommand =
    agent.commandTemplate || "claude";

  startSession({
    sessionId,
    projectDir: project.localPath,
    agentCommand,
    prompt: nextStage.promptTemplate,
  });

  return { completed: false, nextStage: nextStage.name, sessionId };
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
    },
    {
      name: "implement",
      promptTemplate:
        "Implement the changes according to the approved plan. Write clean, well-tested code.",
      autoAdvance: false,
      reviewRequired: true,
    },
    {
      name: "review",
      promptTemplate:
        "Review the implementation for bugs, edge cases, performance issues, and code quality. Suggest improvements.",
      autoAdvance: false,
      reviewRequired: true,
    },
  ];
}
