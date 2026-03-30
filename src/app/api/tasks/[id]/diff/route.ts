import { NextRequest, NextResponse } from "next/server";
import { getDb, schema } from "@/lib/db";
import { eq } from "drizzle-orm";
import { generateTaskDiff, regenerateReviewFromDiff } from "@/lib/services/review-service";

/**
 * GET /api/tasks/[id]/diff
 * Generate a fresh diff for a task's worktree (or committed changes).
 * Useful for debugging and for the review UI to fetch a live diff.
 *
 * Query params:
 *   ?update_review=true  — also update the review's diffSnapshot + aiSummary in the DB
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: taskId } = await params;
  const db = getDb();

  const task = db
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.id, taskId))
    .get();

  if (!task) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  const result = await generateTaskDiff(taskId);

  // Optionally update the review's stored diffSnapshot and aiSummary
  const updateReview = _req.nextUrl.searchParams.get("update_review") === "true";
  if (updateReview && result.diffText) {
    const updated = regenerateReviewFromDiff(taskId, result);
    result.reviewUpdated = updated;
  }

  return NextResponse.json(result);
}
