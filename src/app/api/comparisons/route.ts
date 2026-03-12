import { NextRequest, NextResponse } from "next/server";
import { getDb, schema } from "@/lib/db";
import { eq, and, desc } from "drizzle-orm";
import { startTask } from "@/lib/services/task-manager";
import { generateTitle } from "@/lib/services/title-generator";

export async function GET() {
  const db = getDb();
  const groups = db
    .select()
    .from(schema.comparisonGroups)
    .orderBy(desc(schema.comparisonGroups.createdAt))
    .all();

  // Enrich with task counts
  const enriched = groups.map((group) => {
    const tasks = db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.comparisonGroupId, group.id))
      .all();

    const completed = tasks.filter(
      (t) => t.status === "completed" || t.status === "awaiting_review"
    ).length;

    return {
      ...group,
      taskCount: tasks.length,
      completedCount: completed,
      tasks: tasks.map((t) => ({
        id: t.id,
        agentDefinitionId: t.agentDefinitionId,
        model: t.model,
        status: t.status,
      })),
    };
  });

  return NextResponse.json(enriched);
}

export async function POST(request: NextRequest) {
  const db = getDb();
  const body = await request.json();

  const {
    projectId,
    prompt,
    credentialSetId,
    useWorktree = true,
    variants,
  } = body;

  if (!projectId || !prompt || !Array.isArray(variants) || variants.length < 2) {
    return NextResponse.json(
      {
        error:
          "projectId, prompt, and at least 2 variants are required",
      },
      { status: 400 }
    );
  }

  if (variants.length > 5) {
    return NextResponse.json(
      { error: "Maximum 5 variants allowed" },
      { status: 400 }
    );
  }

  const project = db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId))
    .get();
  if (!project) {
    return NextResponse.json(
      { error: "Project not found" },
      { status: 404 }
    );
  }

  const now = new Date().toISOString();
  const groupId = crypto.randomUUID();

  db.insert(schema.comparisonGroups)
    .values({
      id: groupId,
      projectId,
      prompt,
      status: "running",
      createdAt: now,
    })
    .run();

  // Fire-and-forget title generation
  generateTitle(prompt)
    .then((title) => {
      if (title) {
        db.update(schema.comparisonGroups)
          .set({ title })
          .where(eq(schema.comparisonGroups.id, groupId))
          .run();
      }
    })
    .catch(() => {});

  const createdTasks: Array<{
    taskId: string;
    agentDefinitionId: string;
    agentName: string;
    model: string | null;
    label: string;
  }> = [];

  for (const variant of variants) {
    const { agentDefinitionId, model, label } = variant;

    const agent = db
      .select()
      .from(schema.agentDefinitions)
      .where(eq(schema.agentDefinitions.id, agentDefinitionId))
      .get();

    if (!agent) continue;

    const taskId = crypto.randomUUID();

    db.insert(schema.tasks)
      .values({
        id: taskId,
        projectId,
        agentDefinitionId,
        credentialSetId: credentialSetId || null,
        prompt,
        model: model || null,
        useWorktree: useWorktree ? 1 : 0,
        comparisonGroupId: groupId,
        executionMode: agent.type.includes("acp") ? "acp" : "legacy",
        status: "pending",
        createdAt: now,
      })
      .run();

    // Start each task
    try {
      startTask({
        taskId,
        projectDir: project.localPath,
        agentCommand: agent.commandTemplate || "copilot",
        agentType: agent.type,
        credentialSetId: credentialSetId || null,
        dockerImage: agent.dockerImage,
        prompt,
        model: model || null,
        useWorktree,
      });
    } catch (e) {
      console.error(`Failed to start comparison task ${taskId}:`, e);
      db.update(schema.tasks)
        .set({ status: "failed", completedAt: now })
        .where(eq(schema.tasks.id, taskId))
        .run();
    }

    createdTasks.push({
      taskId,
      agentDefinitionId,
      agentName: agent.name,
      model: model || null,
      label: label || `${agent.name}${model ? ` (${model})` : ""}`,
    });
  }

  // Check if all tasks failed
  const allFailed = createdTasks.length === 0;
  if (allFailed) {
    db.update(schema.comparisonGroups)
      .set({ status: "failed", completedAt: now })
      .where(eq(schema.comparisonGroups.id, groupId))
      .run();
  }

  return NextResponse.json(
    {
      comparisonGroupId: groupId,
      tasks: createdTasks,
    },
    { status: 201 }
  );
}
