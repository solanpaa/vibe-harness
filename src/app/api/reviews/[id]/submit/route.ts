import { NextRequest, NextResponse } from "next/server";
import { getDb, schema } from "@/lib/db";
import { eq } from "drizzle-orm";
import { rerunWithComments } from "@/lib/services/review-rerun";
import { getOriginTaskId } from "@/lib/services/review-service";
import { commitAndMergeWorktree, removeWorktree } from "@/lib/services/worktree";
import { advanceWorkflow } from "@/lib/services/workflow-engine";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = getDb();
  const body = await request.json();
  const action = body.action as "approve" | "request_changes";

  const review = db
    .select()
    .from(schema.reviews)
    .where(eq(schema.reviews.id, id))
    .get();

  if (!review) {
    return NextResponse.json({ error: "Review not found" }, { status: 404 });
  }

  if (action === "approve") {
    db.update(schema.reviews)
      .set({ status: "approved" })
      .where(eq(schema.reviews.id, id))
      .run();

    const originId = getOriginTaskId(review.taskId);
    const task = db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.id, originId))
      .get();

    // Update the task status to completed (from awaiting_review)
    db.update(schema.tasks)
      .set({ status: "completed" })
      .where(eq(schema.tasks.id, review.taskId))
      .run();

    // Advance workflow if this is part of one
    let workflowAdvance = null;
    if (review.workflowRunId) {
      try {
        workflowAdvance = await advanceWorkflow(review.workflowRunId);
      } catch (e) {
        console.error("Failed to advance workflow:", e);
      }
    }

    // Only merge when: (a) not part of a workflow, or (b) workflow is now completed
    const shouldMerge = !review.workflowRunId || workflowAdvance?.completed;
    let mergeResult: { merged: boolean; branch: string; error?: string } | null = null;

    if (shouldMerge && task) {
      const project = db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, task.projectId))
        .get();

      if (project) {
        const shortPrompt = task.prompt.slice(0, 60).replace(/\n/g, " ");
        mergeResult = commitAndMergeWorktree(
          project.localPath,
          originId,
          `vibe-harness: ${shortPrompt}`
        );

        if (mergeResult.merged) {
          try {
            removeWorktree(project.localPath, originId);
          } catch {
            // Non-critical
          }
        }
      }
    }

    return NextResponse.json({
      status: "approved",
      reviewId: id,
      merged: mergeResult?.merged ?? false,
      mergeError: mergeResult?.error ?? null,
      workflowAdvanced: workflowAdvance
        ? !workflowAdvance.completed
          ? { nextStage: workflowAdvance.nextStage, taskId: workflowAdvance.taskId }
          : { completed: true }
        : null,
    });
  }

  if (action === "request_changes") {
    db.update(schema.reviews)
      .set({ status: "changes_requested" })
      .where(eq(schema.reviews.id, id))
      .run();

    // Mark the reviewed task as completed (superseded by the rerun)
    db.update(schema.tasks)
      .set({ status: "completed" })
      .where(eq(schema.tasks.id, review.taskId))
      .run();

    // Bundle comments into prompt and spawn a new agent task
    const result = await rerunWithComments(id);

    if (result) {
      return NextResponse.json({
        status: "changes_requested",
        reviewId: id,
        newTaskId: result.taskId,
        newRound: result.reviewRound,
        message: `New agent task spawned for round ${result.reviewRound}`,
      });
    }

    return NextResponse.json({
      status: "changes_requested",
      reviewId: id,
      message: "Review comments submitted. Could not auto-spawn task.",
    });
  }

  return NextResponse.json(
    { error: "Invalid action. Use 'approve' or 'request_changes'" },
    { status: 400 }
  );
}
