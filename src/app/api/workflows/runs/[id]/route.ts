import { NextRequest, NextResponse } from "next/server";
import { getDb, schema } from "@/lib/db";
import { eq } from "drizzle-orm";
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
  return NextResponse.json(run);
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
        stopTask(task.id);
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
