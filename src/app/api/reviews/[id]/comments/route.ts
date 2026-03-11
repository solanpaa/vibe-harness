import { NextRequest, NextResponse } from "next/server";
import { getDb, schema } from "@/lib/db";
import { v4 as uuid } from "uuid";
import { eq } from "drizzle-orm";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = getDb();
  const comments = db
    .select()
    .from(schema.reviewComments)
    .where(eq(schema.reviewComments.reviewId, id))
    .all();
  return NextResponse.json(comments);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = getDb();
  const body = await request.json();
  const now = new Date().toISOString();
  const comment = {
    id: uuid(),
    reviewId: id,
    filePath: body.filePath,
    lineNumber: body.lineNumber || null,
    side: body.side || null,
    body: body.body,
    createdAt: now,
  };
  db.insert(schema.reviewComments).values(comment).run();
  return NextResponse.json(comment, { status: 201 });
}
