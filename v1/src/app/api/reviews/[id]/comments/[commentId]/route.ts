import { NextRequest, NextResponse } from "next/server";
import { getDb, schema } from "@/lib/db";
import { eq, and } from "drizzle-orm";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; commentId: string }> }
) {
  const { id, commentId } = await params;
  const db = await getDb();
  const deleted = await db
    .delete(schema.reviewComments)
    .where(
      and(
        eq(schema.reviewComments.id, commentId),
        eq(schema.reviewComments.reviewId, id),
      )
    )
    .run();

  if (deleted.rowsAffected === 0) {
    return NextResponse.json({ error: "Comment not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
