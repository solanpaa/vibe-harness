import { NextRequest, NextResponse } from "next/server";
import { getDb, schema } from "@/lib/db";
import { eq } from "drizzle-orm";
import { createReviewForSession } from "@/lib/services/review-service";

export async function GET() {
  const db = getDb();
  const allReviews = db.select().from(schema.reviews).all();
  return NextResponse.json(allReviews);
}

export async function POST(request: NextRequest) {
  const body = await request.json();

  if (!body.sessionId) {
    return NextResponse.json({ error: "sessionId is required" }, { status: 400 });
  }

  try {
    const reviewId = await createReviewForSession(body.sessionId);
    if (!reviewId) {
      return NextResponse.json(
        { error: "Could not create review — session or project not found" },
        { status: 404 }
      );
    }

    const db = getDb();
    const review = db
      .select()
      .from(schema.reviews)
      .where(eq(schema.reviews.id, reviewId))
      .get();

    return NextResponse.json(review, { status: 201 });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Failed to create review";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
