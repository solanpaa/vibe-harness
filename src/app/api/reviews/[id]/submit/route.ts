import { NextRequest, NextResponse } from "next/server";
import { getDb, schema } from "@/lib/db";
import { eq } from "drizzle-orm";
import { rerunWithComments } from "@/lib/services/review-rerun";
import { createReviewForSession } from "@/lib/services/review-service";

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
    return NextResponse.json({ status: "approved", reviewId: id });
  }

  if (action === "request_changes") {
    db.update(schema.reviews)
      .set({ status: "changes_requested" })
      .where(eq(schema.reviews.id, id))
      .run();

    // Bundle comments into prompt and spawn a new agent session
    const result = await rerunWithComments(id);

    if (result) {
      return NextResponse.json({
        status: "changes_requested",
        reviewId: id,
        newSessionId: result.sessionId,
        newRound: result.reviewRound,
        message: `New agent session spawned for round ${result.reviewRound}`,
      });
    }

    return NextResponse.json({
      status: "changes_requested",
      reviewId: id,
      message: "Review comments submitted. Could not auto-spawn session.",
    });
  }

  return NextResponse.json(
    { error: "Invalid action. Use 'approve' or 'request_changes'" },
    { status: 400 }
  );
}
