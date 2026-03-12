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

  // Build shell command with correct working directory
  let shellCommand: string | null = null;
  if (task.sandboxId) {
    const project = db
      .select({ localPath: schema.projects.localPath })
      .from(schema.projects)
      .where(eq(schema.projects.id, task.projectId))
      .get();
    if (project) {
      const originId = task.originTaskId || task.id;
      const shortId = originId.slice(0, 8);
      const workDir = task.useWorktree
        ? `${project.localPath}/.vibe-harness-worktrees/${shortId}`
        : project.localPath;
      shellCommand = `docker sandbox exec -it -w ${workDir} ${task.sandboxId} bash`;
    }
  }

  return NextResponse.json({ ...task, shellCommand });
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

    // Set provisioning status and return immediately — sandbox creation is async
    db.update(schema.tasks)
      .set({ status: "provisioning" })
      .where(eq(schema.tasks.id, id))
      .run();

    // Fire-and-forget: startTask runs in the background
    Promise.resolve().then(() => {
      try {
        startTask({
          taskId: id,
          projectDir: project.localPath,
          agentCommand,
          agentType: agent.type,
          credentialSetId: task.credentialSetId,
          dockerImage: agent.dockerImage,
          prompt: task.prompt,
          model: task.model,
          useWorktree: task.useWorktree === 1,
          originTaskId: task.originTaskId,
          isContinuation: !!task.originTaskId,
          mcpServers: body.mcpServers,
        });
      } catch (e) {
        console.error(`[Task ${id}] Failed to start:`, e);
        db.update(schema.tasks)
          .set({ status: "failed", completedAt: new Date().toISOString() })
          .where(eq(schema.tasks.id, id))
          .run();
      }
    });

    const updated = db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.id, id))
      .get();
    return NextResponse.json(updated);
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

  if (body.action === "resume") {
    const task = db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.id, id))
      .get();
    if (!task) {
      return NextResponse.json({ error: "Task not found" }, { status: 404 });
    }
    if (task.status !== "paused") {
      return NextResponse.json({ error: "Task is not paused" }, { status: 400 });
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

    try {
      // Get the ACP session ID to resume the conversation
      let loadSessionId: string | null = null;
      if (task.workflowRunId) {
        const run = db
          .select({ acpSessionId: schema.workflowRuns.acpSessionId })
          .from(schema.workflowRuns)
          .where(eq(schema.workflowRuns.id, task.workflowRunId))
          .get();
        loadSessionId = run?.acpSessionId || null;
      }

      // Resume with --continue in the existing sandbox, loading the previous session
      startTask({
        taskId: id,
        projectDir: project.localPath,
        agentCommand: agent.commandTemplate || "copilot",
        agentType: agent.type,
        credentialSetId: task.credentialSetId,
        dockerImage: agent.dockerImage,
        prompt: body.message || "Please continue where you left off.",
        model: task.model,
        useWorktree: task.useWorktree === 1,
        originTaskId: task.originTaskId || task.id,
        isContinuation: true,
        loadSessionId,
      });

      // Unpause the workflow run
      if (task.workflowRunId) {
        db.update(schema.workflowRuns)
          .set({ status: "running" })
          .where(eq(schema.workflowRuns.id, task.workflowRunId))
          .run();
      }

      const updated = db
        .select()
        .from(schema.tasks)
        .where(eq(schema.tasks.id, id))
        .get();
      return NextResponse.json(updated);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Failed to resume task";
      return NextResponse.json({ error: message }, { status: 500 });
    }
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

  // Delete associated reviews and their comments first (no cascade rule in schema)
  const reviews = db
    .select({ id: schema.reviews.id })
    .from(schema.reviews)
    .where(eq(schema.reviews.taskId, id))
    .all();
  for (const review of reviews) {
    db.delete(schema.reviewComments)
      .where(eq(schema.reviewComments.reviewId, review.id))
      .run();
  }
  db.delete(schema.reviews).where(eq(schema.reviews.taskId, id)).run();

  // Clear originTaskId references from child tasks (avoid orphan FK errors)
  db.update(schema.tasks)
    .set({ originTaskId: null })
    .where(eq(schema.tasks.originTaskId, id))
    .run();

  // taskMessages cascade automatically via schema onDelete rule
  db.delete(schema.tasks).where(eq(schema.tasks.id, id)).run();
  return NextResponse.json({ ok: true });
}
