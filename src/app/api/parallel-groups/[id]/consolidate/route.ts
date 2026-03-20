import { NextRequest, NextResponse } from "next/server";
import { getDb, schema } from "@/lib/db";
import { eq } from "drizzle-orm";
import { transitionWorkflowRun } from "@/lib/state-machine";
import { consolidateParallelGroup } from "@/lib/services/parallel-launcher";

/**
 * POST /api/parallel-groups/[id]/consolidate — merge all child branches.
 * First consolidates via git merge, then transitions the parent workflow.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = getDb();

  try {
    // Find the parent workflow run
    const group = db
      .select({ sourceWorkflowRunId: schema.parallelGroups.sourceWorkflowRunId })
      .from(schema.parallelGroups)
      .where(eq(schema.parallelGroups.id, id))
      .get();

    // Perform the actual git consolidation
    const mergeResult = consolidateParallelGroup(id);

    // Transition the parent workflow via state machine
    if (group?.sourceWorkflowRunId) {
      if (mergeResult.success) {
        await transitionWorkflowRun(group.sourceWorkflowRunId, { type: "CONSOLIDATE" });
      } else if (mergeResult.error?.includes("conflict")) {
        await transitionWorkflowRun(group.sourceWorkflowRunId, { type: "MERGE_CONFLICT" });
      } else {
        await transitionWorkflowRun(group.sourceWorkflowRunId, { type: "FAIL" });
      }
    }

    if (mergeResult.success) {
      return NextResponse.json({
        status: "consolidated",
        branch: mergeResult.branch,
        mergedCount: mergeResult.mergedCount,
      });
    } else {
      return NextResponse.json(
        {
          status: "failed",
          branch: mergeResult.branch,
          mergedCount: mergeResult.mergedCount,
          error: mergeResult.error,
        },
        { status: mergeResult.error?.includes("not found") ? 404 : 409 }
      );
    }
  } catch (error) {
    return NextResponse.json(
      { error: (error as Error).message },
      { status: 500 }
    );
  }
}
