import { NextRequest, NextResponse } from "next/server";
import { getDb, schema } from "@/lib/db";
import { eq } from "drizzle-orm";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = await getDb();
  const review = await db
    .select()
    .from(schema.reviews)
    .where(eq(schema.reviews.id, id))
    .get();
  if (!review) {
    return NextResponse.json({ error: "Review not found" }, { status: 404 });
  }
  return NextResponse.json(review);
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = await getDb();
  const body = await request.json();
  await db.update(schema.reviews)
    .set(body)
    .where(eq(schema.reviews.id, id))
    .run();
  const updated = await db
    .select()
    .from(schema.reviews)
    .where(eq(schema.reviews.id, id))
    .get();
  return NextResponse.json(updated);
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = await getDb();
  await db.delete(schema.reviewComments)
    .where(eq(schema.reviewComments.reviewId, id))
    .run();
  await db.delete(schema.reviews).where(eq(schema.reviews.id, id)).run();
  return NextResponse.json({ ok: true });
}
