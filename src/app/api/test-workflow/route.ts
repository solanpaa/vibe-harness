import { NextRequest, NextResponse } from "next/server";
import { getDb, schema } from "@/lib/db";
import { eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { startWorkflowRun, createWorkflowTemplate, getDefaultWorkflowStages } from "@/lib/services/workflow-engine";

/**
 * POST /api/test-workflow
 *
 * Creates a test project (if needed), a 3-stage workflow template (if needed),
 * and starts a workflow run. Returns IDs for monitoring.
 *
 * Usage: curl -X POST http://localhost:3000/api/test-workflow
 */
export async function POST(request: NextRequest) {
  const db = getDb();
  const body = await request.json().catch(() => ({}));
  const projectPath = body.projectPath || process.cwd();
  const taskDescription = body.taskDescription || "List the top-level files and describe what this project does in 2 sentences. Be very brief.";

  // 1. Ensure a test project exists
  let project = db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.name, "E2E Test Project"))
    .get();

  if (!project) {
    const now = new Date().toISOString();
    project = {
      id: uuid(),
      name: "E2E Test Project",
      gitUrl: null,
      localPath: projectPath,
      description: "Auto-created for E2E testing",
      defaultCredentialSetId: null,
      createdAt: now,
      updatedAt: now,
    };
    db.insert(schema.projects).values(project).run();
  }

  // 2. Ensure a 3-stage workflow template exists
  let template = db
    .select()
    .from(schema.workflowTemplates)
    .where(eq(schema.workflowTemplates.name, "E2E Test Workflow"))
    .get();

  if (!template) {
    const stages = [
      {
        name: "plan",
        promptTemplate: "Analyze the codebase and create a brief implementation plan. Do not make any code changes.",
        reviewRequired: true,
        autoAdvance: false,
        freshSession: false,
      },
      {
        name: "implement",
        promptTemplate: "Implement the changes according to the plan from the previous stage.",
        reviewRequired: true,
        autoAdvance: false,
        freshSession: false,
      },
      {
        name: "review",
        promptTemplate: "Review the implementation for bugs and issues. Provide a brief summary.",
        reviewRequired: true,
        autoAdvance: false,
        freshSession: false,
      },
    ];
    createWorkflowTemplate({
      name: "E2E Test Workflow",
      description: "3-stage workflow for E2E testing",
      stages,
    });
    template = db
      .select()
      .from(schema.workflowTemplates)
      .where(eq(schema.workflowTemplates.name, "E2E Test Workflow"))
      .get();
  }

  if (!template) {
    return NextResponse.json({ error: "Failed to create workflow template" }, { status: 500 });
  }

  // 3. Get the default agent
  const agent = db.select().from(schema.agentDefinitions).get();
  if (!agent) {
    return NextResponse.json({ error: "No agent definitions found" }, { status: 500 });
  }

  // 4. Start the workflow run
  try {
    const result = await startWorkflowRun({
      workflowTemplateId: template.id,
      projectId: project.id,
      taskDescription,
      agentDefinitionId: agent.id,
      useWorktree: false, // simpler for testing
    });

    return NextResponse.json({
      message: "Workflow started",
      ...result,
      projectId: project.id,
      templateId: template.id,
      agentId: agent.id,
      monitorUrls: {
        task: `http://localhost:3000/api/tasks/${result.taskId}`,
        stream: `http://localhost:3000/api/tasks/${result.taskId}/stream`,
        workflow: `http://localhost:3000/api/workflows/${template.id}`,
      },
    }, { status: 201 });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * GET /api/test-workflow
 *
 * Returns the status of all workflow runs for the E2E test project.
 */
export async function GET() {
  const db = getDb();

  const project = db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.name, "E2E Test Project"))
    .get();

  if (!project) {
    return NextResponse.json({ message: "No test project exists. POST to create one." });
  }

  const runs = db
    .select()
    .from(schema.workflowRuns)
    .where(eq(schema.workflowRuns.projectId, project.id))
    .all();

  const enrichedRuns = runs.map((run) => {
    const tasks = db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.workflowRunId, run.id))
      .all();

    return {
      ...run,
      tasks: tasks.map((t) => ({
        id: t.id,
        stageName: t.stageName,
        status: t.status,
        lastAiMessage: t.lastAiMessage?.slice(0, 200),
        createdAt: t.createdAt,
        completedAt: t.completedAt,
      })),
    };
  });

  return NextResponse.json(enrichedRuns);
}
