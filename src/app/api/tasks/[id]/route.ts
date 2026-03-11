import { NextRequest, NextResponse } from "next/server";
import { getDb, schema } from "@/lib/db";
import { eq } from "drizzle-orm";
import { startTask, stopTask } from "@/lib/services/task-manager";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = getDb();
  const task = db
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.id, id))
    .get();
  if (!task) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }
  return NextResponse.json(task);
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = getDb();
  const body = await request.json();

  // Handle start/stop actions
  if (body.action === "start") {
    const task = db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.id, id))
      .get();
    if (!task) {
      return NextResponse.json({ error: "Task not found" }, { status: 404 });
    }

    const project = db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, task.projectId))
      .get();
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const agent = db
      .select()
      .from(schema.agentDefinitions)
      .where(eq(schema.agentDefinitions.id, task.agentDefinitionId))
      .get();
    if (!agent) {
      return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    }

    const agentCommand =
      agent.commandTemplate || "claude";

    try {
      startTask({
        taskId: id,
        projectDir: project.localPath,
        agentCommand,
        credentialSetId: task.credentialSetId,
        dockerImage: agent.dockerImage,
        prompt: task.prompt,
        model: task.model,
        useWorktree: task.useWorktree === 1,
        originTaskId: task.originTaskId,
        isContinuation: !!task.originTaskId,
      });
      const updated = db
        .select()
        .from(schema.tasks)
        .where(eq(schema.tasks.id, id))
        .get();
      return NextResponse.json(updated);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Failed to start task";
      return NextResponse.json({ error: message }, { status: 500 });
    }
  }

  if (body.action === "stop") {
    stopTask(id);
    const updated = db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.id, id))
      .get();
    return NextResponse.json(updated);
  }

  // Generic update
  db.update(schema.tasks)
    .set(body)
    .where(eq(schema.tasks.id, id))
    .run();
  const updated = db
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.id, id))
    .get();
  return NextResponse.json(updated);
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = getDb();
  db.delete(schema.tasks).where(eq(schema.tasks.id, id)).run();
  return NextResponse.json({ ok: true });
}
