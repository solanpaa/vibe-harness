import { NextRequest, NextResponse } from "next/server";
import { getDb, schema } from "@/lib/db";
import { eq } from "drizzle-orm";
import { transitionWorkflowRun } from "@/lib/state-machine";
import { stopTask } from "@/lib/services/task-manager";
import { removeWorktree } from "@/lib/services/worktree";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = getDb();
  const run = db
    .select()
    .from(schema.workflowRuns)
    .where(eq(schema.workflowRuns.id, id))
    .get();
  if (!run) {
    return NextResponse.json({ error: "Workflow run not found" }, { status: 404 });
  }

  // Include the parallel group ID if this workflow has spawned one
  const group = db
    .select({ id: schema.parallelGroups.id })
    .from(schema.parallelGroups)
    .where(eq(schema.parallelGroups.sourceWorkflowRunId, id))
    .get();

  return NextResponse.json({
    ...run,
    activeParallelGroupId: group?.id ?? null,
  });
}

/** Pause, resume, or cancel a workflow run */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = getDb();
  const body = await request.json();

  const run = db
    .select()
    .from(schema.workflowRuns)
    .where(eq(schema.workflowRuns.id, id))
    .get();
  if (!run) {
    return NextResponse.json({ error: "Workflow run not found" }, { status: 404 });
  }

  if (body.action === "pause") {
    const result = await transitionWorkflowRun(id, { type: "PAUSE" });
    if (!result.ok) {
      return NextResponse.json(
        { error: `Cannot pause: ${result.error}` },
        { status: 409 }
      );
    }
    const updated = db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, id)).get();
    return NextResponse.json(updated);
  }

  if (body.action === "resume") {
    const result = await transitionWorkflowRun(id, { type: "RESUME" });
    if (!result.ok) {
      return NextResponse.json(
        { error: `Cannot resume: ${result.error}` },
        { status: 409 }
      );
    }
    const updated = db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, id)).get();
    return NextResponse.json(updated);
  }

  if (body.action === "cancel") {
    const result = await transitionWorkflowRun(id, { type: "CANCEL" });
    if (!result.ok) {
      return NextResponse.json(
        { error: `Cannot cancel: ${result.error}` },
        { status: 409 }
      );
    }
    const updated = db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, id)).get();
    return NextResponse.json(updated);
  }

  return NextResponse.json(
    { error: "Invalid action. Use 'pause', 'resume', or 'cancel'" },
    { status: 400 }
  );
}

/** Delete a workflow run and all its associated data */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = getDb();

  const run = db
    .select()
    .from(schema.workflowRuns)
    .where(eq(schema.workflowRuns.id, id))
    .get();
  if (!run) {
    return NextResponse.json({ error: "Workflow run not found" }, { status: 404 });
  }

  const project = db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, run.projectId))
    .get();

  // Find all tasks in this workflow run
  const tasks = db
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.workflowRunId, id))
    .all();

  // 1. Stop any running tasks
  for (const task of tasks) {
    if (task.status === "running") {
      try {
        await stopTask(task.id);
      } catch {
        // Best effort — sandbox may already be gone
      }
    }
  }

  // 2. Delete review comments and reviews for each task
  for (const task of tasks) {
    const reviews = db
      .select()
      .from(schema.reviews)
      .where(eq(schema.reviews.taskId, task.id))
      .all();

    for (const review of reviews) {
      db.delete(schema.reviewComments)
        .where(eq(schema.reviewComments.reviewId, review.id))
        .run();
    }

    db.delete(schema.reviews)
      .where(eq(schema.reviews.taskId, task.id))
      .run();
  }

  // 3. Delete task messages and tasks
  for (const task of tasks) {
    db.delete(schema.taskMessages)
      .where(eq(schema.taskMessages.taskId, task.id))
      .run();
    db.delete(schema.tasks)
      .where(eq(schema.tasks.id, task.id))
      .run();
  }

  // 4. Delete any remaining reviews linked directly to the workflow run
  const orphanedReviews = db
    .select()
    .from(schema.reviews)
    .where(eq(schema.reviews.workflowRunId, id))
    .all();
  for (const review of orphanedReviews) {
    db.delete(schema.reviewComments)
      .where(eq(schema.reviewComments.reviewId, review.id))
      .run();
    db.delete(schema.reviews)
      .where(eq(schema.reviews.id, review.id))
      .run();
  }

  // 5. Clean up worktrees (use origin task for the worktree path)
  if (project) {
    const cleaned = new Set<string>();
    for (const task of tasks) {
      const worktreeTaskId = task.originTaskId || task.id;
      if (!cleaned.has(worktreeTaskId)) {
        cleaned.add(worktreeTaskId);
        try {
          removeWorktree(project.localPath, worktreeTaskId);
        } catch {
          // Best effort — worktree may not exist
        }
      }
    }
  }

  // 6. Delete the workflow run itself
  db.delete(schema.workflowRuns)
    .where(eq(schema.workflowRuns.id, id))
    .run();

  return NextResponse.json({ ok: true });
}
