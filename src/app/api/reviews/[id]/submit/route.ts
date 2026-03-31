import { NextRequest, NextResponse } from "next/server";
import { getDb, schema } from "@/lib/db";
import { eq } from "drizzle-orm";
import { transitionWorkflowRun } from "@/lib/state-machine";
import { getOriginTaskId } from "@/lib/services/review-service";
import { finalizeAndMerge } from "@/lib/services/task-manager";
import { commitAndMergeWorktree, removeWorktree } from "@/lib/services/worktree";

/**
 * Run finalizeAndMerge in the background and transition the workflow state.
 * Does NOT block the HTTP response.
 */
function backgroundMerge(
  originId: string,
  workflowRunId: string | null,
  targetBranch: string | undefined,
) {
  Promise.resolve().then(async () => {
    const db = getDb();
    try {
      let mergeResult = finalizeAndMerge(originId, { workflowRunId, targetBranch });

      if (workflowRunId) {
        if (mergeResult.merged) {
          await transitionWorkflowRun(workflowRunId, { type: "FINALIZE" });
        } else {
          console.error("[backgroundMerge] Merge failed:", mergeResult.error);
          // Fallback: commitAndMergeWorktree
          const task = db.select().from(schema.tasks).where(eq(schema.tasks.id, originId)).get();
          const project = task
            ? db.select().from(schema.projects).where(eq(schema.projects.id, task.projectId)).get()
            : null;

          if (project && task) {
            const shortPrompt = task.prompt.slice(0, 60).replace(/\n/g, " ");
            mergeResult = commitAndMergeWorktree(
              project.localPath,
              originId,
              `vibe-harness: ${shortPrompt}`,
              targetBranch,
            );
            if (mergeResult.merged) {
              try { removeWorktree(project.localPath, originId); } catch { /* non-critical */ }
              await transitionWorkflowRun(workflowRunId, { type: "FINALIZE" });
            } else {
              await transitionWorkflowRun(workflowRunId, { type: "MERGE_CONFLICT" });
            }
          } else {
            await transitionWorkflowRun(workflowRunId, { type: "MERGE_CONFLICT" });
          }
        }
      }
      console.log(`[backgroundMerge] Done for ${originId}: merged=${mergeResult.merged}`);
    } catch (e) {
      console.error("[backgroundMerge] Unhandled error:", e);
      if (workflowRunId) {
        try {
          await transitionWorkflowRun(workflowRunId, { type: "MERGE_CONFLICT" });
        } catch { /* don't leave stuck */ }
      }
    }
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = getDb();
  const body = await request.json();
  const action = body.action as "approve" | "request_changes" | "split";
  const targetBranch = body.targetBranch as string | undefined;

  const review = db
    .select()
    .from(schema.reviews)
    .where(eq(schema.reviews.id, id))
    .get();

  if (!review) {
    return NextResponse.json({ error: "Review not found" }, { status: 404 });
  }

  if (review.status !== "pending_review") {
    return NextResponse.json(
      { error: `Review already processed (status: ${review.status})` },
      { status: 409 }
    );
  }

  if (action === "approve") {
    const originId = getOriginTaskId(review.taskId);

    if (targetBranch) {
      db.update(schema.tasks)
        .set({ targetBranch })
        .where(eq(schema.tasks.id, originId))
        .run();
    }

    if (!review.workflowRunId) {
      // Non-workflow task: approve and merge in background
      db.update(schema.reviews)
        .set({ status: "approved" })
        .where(eq(schema.reviews.id, id))
        .run();

      backgroundMerge(originId, null, targetBranch);

      return NextResponse.json({
        status: "approved",
        reviewId: id,
        merging: true,
        message: "Approved — merge running in background",
        workflowAdvanced: null,
      });
    }

    // Workflow task: transition via state machine → finalizing or running
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

    if (result.to === "finalizing") {
      // Last stage — kick off merge in background, return immediately
      backgroundMerge(originId, review.workflowRunId, targetBranch);

      return NextResponse.json({
        status: "approved",
        reviewId: id,
        merging: true,
        message: "Approved — merge running in background",
        workflowAdvanced: { finalizing: true },
      });
    }

    if (result.to === "running") {
      return NextResponse.json({
        status: "approved",
        reviewId: id,
        merging: false,
        workflowAdvanced: { nextStage: true },
      });
    }

    return NextResponse.json({
      status: "approved",
      reviewId: id,
      merging: false,
      workflowAdvanced: { state: result.to },
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
