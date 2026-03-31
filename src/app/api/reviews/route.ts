import { NextRequest, NextResponse } from "next/server";
import { getDb, schema } from "@/lib/db";
import { eq } from "drizzle-orm";
import { createReviewForTask } from "@/lib/services/review-service";

export async function GET() {
  const db = await getDb();
  const allReviews = await db.select().from(schema.reviews).all();
  return NextResponse.json(allReviews);
}

export async function POST(request: NextRequest) {
  const body = await request.json();

  if (!body.taskId) {
    return NextResponse.json({ error: "taskId is required" }, { status: 400 });
  }

  try {
    const reviewId = await createReviewForTask(body.taskId);
    if (!reviewId) {
      return NextResponse.json(
        { error: "Could not create review — task or project not found" },
        { status: 404 }
      );
    }

    const db = await getDb();
    const review = await db
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
