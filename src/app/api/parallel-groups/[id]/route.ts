import { NextRequest, NextResponse } from "next/server";
import { getDb, schema } from "@/lib/db";
import { eq } from "drizzle-orm";

/**
 * GET /api/parallel-groups/[id] — get parallel group with child run statuses.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = getDb();

  const group = db
    .select()
    .from(schema.parallelGroups)
    .where(eq(schema.parallelGroups.id, id))
    .get();

  if (!group) {
    return NextResponse.json(
      { error: "Parallel group not found" },
      { status: 404 }
    );
  }

  // Get all workflow runs in this group
  const childRuns = db
    .select({
      id: schema.workflowRuns.id,
      title: schema.workflowRuns.title,
      status: schema.workflowRuns.status,
      currentStage: schema.workflowRuns.currentStage,
      sourceProposalId: schema.workflowRuns.sourceProposalId,
      createdAt: schema.workflowRuns.createdAt,
      completedAt: schema.workflowRuns.completedAt,
    })
    .from(schema.workflowRuns)
    .where(eq(schema.workflowRuns.parallelGroupId, id))
    .all();

  // Get proposals linked to this group
  const proposals = db
    .select()
    .from(schema.taskProposals)
    .where(eq(schema.taskProposals.parallelGroupId, id))
    .all()
    .map((p) => ({
      ...p,
      affectedFiles: p.affectedFiles ? JSON.parse(p.affectedFiles) : [],
      dependsOn: p.dependsOn ? JSON.parse(p.dependsOn) : [],
    }));

  // Summary stats
  const total = childRuns.length;
  const completed = childRuns.filter((r) => r.status === "completed").length;
  const running = childRuns.filter(
    (r) => r.status === "running" || r.status === "awaiting_review"
  ).length;
  const failed = childRuns.filter((r) => r.status === "failed").length;
  const pending = childRuns.filter((r) => r.status === "pending").length;

  return NextResponse.json({
    ...group,
    proposals,
    childRuns,
    summary: { total, completed, running, failed, pending },
  });
}
