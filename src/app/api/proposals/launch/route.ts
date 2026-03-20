import { NextRequest, NextResponse } from "next/server";
import { getDb, schema } from "@/lib/db";
import { eq } from "drizzle-orm";
import { transitionWorkflowRun } from "@/lib/state-machine";

/**
 * POST /api/proposals/launch — launch approved proposals as parallel workflow runs.
 * Body: { taskId, proposalIds?, workflowTemplateId? }
 *
 * Transitions the parent workflow from awaiting_split_review → running_parallel.
 * The state machine's createParallelGroup action handles launching proposals.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { taskId, proposalIds, workflowTemplateId, useFullWorkflow } = body;

    if (!taskId) {
      return NextResponse.json(
        { error: "taskId is required" },
        { status: 400 }
      );
    }

    // Find the workflow run for this task
    const db = getDb();
    const task = db
      .select({ workflowRunId: schema.tasks.workflowRunId })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, taskId))
      .get();

    if (!task?.workflowRunId) {
      return NextResponse.json(
        { error: "Task is not part of a workflow" },
        { status: 400 }
      );
    }

    // Transition via state machine — fires createParallelGroup + launchChildWorkflows
    const result = await transitionWorkflowRun(task.workflowRunId, {
      type: "LAUNCH_PROPOSALS",
      taskId,
      proposalIds,
      workflowTemplateId,
      useFullWorkflow,
    });

    if (!result.ok) {
      return NextResponse.json(
        { error: `Transition failed: ${result.error}` },
        { status: 409 }
      );
    }

    return NextResponse.json(
      { status: "launched", workflowRunId: task.workflowRunId },
      { status: 201 }
    );
  } catch (error) {
    console.error("[Launch Proposals]", error);
    return NextResponse.json(
      { error: (error as Error).message },
      { status: 500 }
    );
  }
}
