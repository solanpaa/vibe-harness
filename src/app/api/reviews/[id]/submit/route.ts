import { NextRequest, NextResponse } from "next/server";
import { getDb, schema } from "@/lib/db";
import { eq } from "drizzle-orm";
import { transitionWorkflowRun } from "@/lib/state-machine";
import { getOriginTaskId } from "@/lib/services/review-service";
import { finalizeAndMerge } from "@/lib/services/task-manager";
import { commitAndMergeWorktree, removeWorktree } from "@/lib/services/worktree";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = getDb();
  const body = await request.json();
  const action = body.action as "approve" | "request_changes" | "split";

  const review = db
    .select()
    .from(schema.reviews)
    .where(eq(schema.reviews.id, id))
    .get();

  if (!review) {
    return NextResponse.json({ error: "Review not found" }, { status: 404 });
  }

  if (action === "approve") {
    if (!review.workflowRunId) {
      // Non-workflow task: just approve the review directly
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

      let mergeResult: { merged: boolean; branch: string; error?: string } | null = null;
      if (task) {
        try {
          mergeResult = finalizeAndMerge(originId);
        } catch (e) {
          console.error("Failed to finalize:", e);
        }
      }

      return NextResponse.json({
        status: "approved",
        reviewId: id,
        merged: mergeResult?.merged ?? false,
        mergeError: mergeResult?.error ?? null,
        workflowAdvanced: null,
      });
    }

    // Workflow task: transition via state machine
    const result = await transitionWorkflowRun(review.workflowRunId, {
      type: "APPROVE",
      reviewId: id,
    });

    if (!result.ok) {
      return NextResponse.json(
        { error: `Transition failed: ${result.error}` },
        { status: 409 }
      );
    }

    let mergeResult: { merged: boolean; branch: string; error?: string } | null = null;
    let workflowAdvanced: Record<string, unknown> | null = null;

    if (result.to === "finalizing") {
      // Last stage — attempt merge
      const originId = getOriginTaskId(review.taskId);
      try {
        mergeResult = finalizeAndMerge(originId, {
          workflowRunId: review.workflowRunId,
        });

        if (mergeResult.merged) {
          await transitionWorkflowRun(review.workflowRunId, { type: "FINALIZE" });
          workflowAdvanced = { completed: true };
        } else {
          await transitionWorkflowRun(review.workflowRunId, { type: "MERGE_CONFLICT" });
          workflowAdvanced = { mergeConflict: true, error: mergeResult.error };
        }
      } catch (e) {
        console.error("Failed to finalize, falling back to mechanical merge:", e);
        const task = db
          .select()
          .from(schema.tasks)
          .where(eq(schema.tasks.id, originId))
          .get();
        const project = task
          ? db.select().from(schema.projects).where(eq(schema.projects.id, task.projectId)).get()
          : null;

        if (project && task) {
          const shortPrompt = task.prompt.slice(0, 60).replace(/\n/g, " ");
          mergeResult = commitAndMergeWorktree(
            project.localPath,
            originId,
            `vibe-harness: ${shortPrompt}`
          );
          if (mergeResult.merged) {
            try { removeWorktree(project.localPath, originId); } catch { /* non-critical */ }
            await transitionWorkflowRun(review.workflowRunId, { type: "FINALIZE" });
            workflowAdvanced = { completed: true };
          } else {
            await transitionWorkflowRun(review.workflowRunId, { type: "MERGE_CONFLICT" });
            workflowAdvanced = { mergeConflict: true, error: mergeResult.error };
          }
        }
      }
    } else if (result.to === "running") {
      // Advancing to next stage (launchNextStageTask action fired)
      workflowAdvanced = { nextStage: true };
    }

    return NextResponse.json({
      status: "approved",
      reviewId: id,
      merged: mergeResult?.merged ?? false,
      mergeError: mergeResult?.error ?? null,
      workflowAdvanced,
    });
  }

  if (action === "request_changes") {
    if (!review.workflowRunId) {
      // Non-workflow: just mark review and import rerun directly
      db.update(schema.reviews)
        .set({ status: "changes_requested" })
        .where(eq(schema.reviews.id, id))
        .run();

      const { rerunWithComments } = await import("@/lib/services/review-rerun");
      const result = await rerunWithComments(id);

      return NextResponse.json({
        status: "changes_requested",
        reviewId: id,
        newTaskId: result?.taskId ?? null,
        newRound: result?.reviewRound ?? null,
        message: result
          ? `New agent task spawned for round ${result.reviewRound}`
          : "Review comments submitted. Could not auto-spawn task.",
      });
    }

    // Workflow task: transition via state machine
    const result = await transitionWorkflowRun(review.workflowRunId, {
      type: "REQUEST_CHANGES",
      reviewId: id,
    });

    if (!result.ok) {
      return NextResponse.json(
        { error: `Transition failed: ${result.error}` },
        { status: 409 }
      );
    }

    return NextResponse.json({
      status: "changes_requested",
      reviewId: id,
      message: "Changes requested — rerun task spawned.",
    });
  }

  if (action === "split") {
    if (!review.workflowRunId) {
      return NextResponse.json(
        { error: "Split is only available for workflow tasks" },
        { status: 400 }
      );
    }

    const result = await transitionWorkflowRun(review.workflowRunId, {
      type: "SPLIT",
      reviewId: id,
    });

    if (!result.ok) {
      return NextResponse.json(
        { error: `Transition failed: ${result.error}` },
        { status: 409 }
      );
    }

    return NextResponse.json({
      status: "split",
      reviewId: id,
      message: "Plan approved — split agent launched to decompose into sub-tasks",
    });
  }

  return NextResponse.json(
    { error: "Invalid action. Use 'approve', 'request_changes', or 'split'" },
    { status: 400 }
  );
}
