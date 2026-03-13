import { NextRequest, NextResponse } from "next/server";
import { launchProposals } from "@/lib/services/parallel-launcher";

/**
 * POST /api/proposals/launch — launch approved proposals as parallel workflow runs.
 * Body: { taskId, proposalIds?, workflowTemplateId? }
 *
 * If proposalIds is omitted, all non-discarded proposals for the task are launched.
 * workflowTemplateId defaults to a simple "implement → review" template.
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

    const result = await launchProposals({
      taskId,
      proposalIds,
      workflowTemplateId,
      useFullWorkflow,
    });

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    console.error("[Launch Proposals]", error);
    return NextResponse.json(
      { error: (error as Error).message },
      { status: 500 }
    );
  }
}
