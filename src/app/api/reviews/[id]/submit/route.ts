import { NextRequest, NextResponse } from "next/server";
import { getDb, schema } from "@/lib/db";
import { eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { rerunWithComments } from "@/lib/services/review-rerun";
import { getOriginTaskId } from "@/lib/services/review-service";
import { commitAndMergeWorktree, removeWorktree } from "@/lib/services/worktree";
import { finalizeAndMerge, startTask } from "@/lib/services/task-manager";
import { advanceWorkflow, getPlanAndSplitStages, buildStagePrompt } from "@/lib/services/workflow-engine";

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

    // Only finalize when: (a) not part of a workflow, or (b) workflow is now completed
    const shouldFinalize = !review.workflowRunId || workflowAdvance?.completed;
    let mergeResult: { merged: boolean; branch: string; error?: string } | null = null;

    if (shouldFinalize && task) {
      try {
        mergeResult = finalizeAndMerge(originId, {
          workflowRunId: review.workflowRunId,
        });
      } catch (e) {
        console.error("Failed to finalize, falling back to mechanical merge:", e);
        // Fallback: mechanical merge
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
    }

    return NextResponse.json({
      status: "approved",
      reviewId: id,
      merged: mergeResult?.merged ?? false,
      mergeError: mergeResult?.error ?? null,
      workflowAdvanced: workflowAdvance
        ? workflowAdvance.splitReview
          ? { splitReview: true }
          : !workflowAdvance.completed
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

  if (action === "split") {
    // Approve the review, then launch a split agent task in the same workflow
    if (!review.workflowRunId) {
      return NextResponse.json(
        { error: "Split is only available for workflow tasks" },
        { status: 400 }
      );
    }

    db.update(schema.reviews)
      .set({ status: "approved" })
      .where(eq(schema.reviews.id, id))
      .run();

    db.update(schema.tasks)
      .set({ status: "completed" })
      .where(eq(schema.tasks.id, review.taskId))
      .run();

    // Get the workflow run and project
    const run = db
      .select()
      .from(schema.workflowRuns)
      .where(eq(schema.workflowRuns.id, review.workflowRunId))
      .get();

    if (!run) {
      return NextResponse.json(
        { error: "Workflow run not found" },
        { status: 404 }
      );
    }

    const project = db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, run.projectId))
      .get();

    if (!project) {
      return NextResponse.json(
        { error: "Project not found" },
        { status: 404 }
      );
    }

    // Get the first task in this workflow (origin) for sandbox/worktree reuse
    const firstTask = db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.workflowRunId, review.workflowRunId))
      .all()
      .filter((t) => !t.originTaskId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];

    if (!firstTask) {
      return NextResponse.json(
        { error: "No origin task found for this workflow" },
        { status: 500 }
      );
    }

    // Get the split stage prompt
    const splitStages = getPlanAndSplitStages();
    const splitStage = splitStages.find((s) => s.name === "split")!;
    const prompt = buildStagePrompt(
      run.taskDescription || firstTask.prompt,
      splitStage,
      review.planMarkdown || review.aiSummary || null
    );

    // Create the split task
    const now = new Date().toISOString();
    const splitTaskId = uuid();
    db.insert(schema.tasks)
      .values({
        id: splitTaskId,
        projectId: run.projectId,
        workflowRunId: review.workflowRunId,
        stageName: "split",
        agentDefinitionId: firstTask.agentDefinitionId,
        credentialSetId: firstTask.credentialSetId,
        sandboxId: null,
        originTaskId: firstTask.id,
        status: "provisioning",
        prompt,
        model: firstTask.model,
        useWorktree: firstTask.useWorktree,
        output: null,
        createdAt: now,
        completedAt: null,
      })
      .run();

    // Update workflow run to reflect the split stage
    db.update(schema.workflowRuns)
      .set({ currentStage: "split", status: "running" })
      .where(eq(schema.workflowRuns.id, review.workflowRunId))
      .run();

    // Store the ACP session so the split task can use --continue
    const agent = db
      .select()
      .from(schema.agentDefinitions)
      .where(eq(schema.agentDefinitions.id, firstTask.agentDefinitionId))
      .get();

    // Launch the split task in background
    Promise.resolve().then(() => {
      try {
        startTask({
          taskId: splitTaskId,
          projectDir: project.localPath,
          agentCommand: agent?.commandTemplate || "copilot",
          dockerImage: agent?.dockerImage,
          credentialSetId: firstTask.credentialSetId,
          prompt,
          model: firstTask.model,
          useWorktree: firstTask.useWorktree === 1,
          isContinuation: false,
          originTaskId: firstTask.id,
          loadSessionId: null,
        });
      } catch (e) {
        console.error("Failed to launch split task:", e);
        db.update(schema.tasks)
          .set({ status: "failed", completedAt: new Date().toISOString() })
          .where(eq(schema.tasks.id, splitTaskId))
          .run();
        db.update(schema.workflowRuns)
          .set({ status: "failed", completedAt: new Date().toISOString() })
          .where(eq(schema.workflowRuns.id, review.workflowRunId!))
          .run();
      }
    });

    return NextResponse.json({
      status: "split",
      reviewId: id,
      splitTaskId,
      message: "Plan approved — split agent launched to decompose into sub-tasks",
    });
  }

  return NextResponse.json(
    { error: "Invalid action. Use 'approve', 'request_changes', or 'split'" },
    { status: 400 }
  );
}
