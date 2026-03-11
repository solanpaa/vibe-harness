import { NextRequest, NextResponse } from "next/server";
import { getDb, schema } from "@/lib/db";
import { v4 as uuid } from "uuid";
import { eq } from "drizzle-orm";

export async function GET() {
  const db = getDb();
  const allReviews = db.select().from(schema.reviews).all();
  return NextResponse.json(allReviews);
}

export async function POST(request: NextRequest) {
  const db = getDb();
  const body = await request.json();
  const now = new Date().toISOString();
  const review = {
    id: uuid(),
    workflowRunId: body.workflowRunId || null,
    sessionId: body.sessionId,
    round: body.round || 1,
    status: "pending_review" as const,
    aiSummary: body.aiSummary || null,
    diffSnapshot: body.diffSnapshot || null,
    createdAt: now,
  };
  db.insert(schema.reviews).values(review).run();
  return NextResponse.json(review, { status: 201 });
}
