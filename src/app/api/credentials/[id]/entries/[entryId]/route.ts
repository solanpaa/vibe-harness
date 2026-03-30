import { NextRequest, NextResponse } from "next/server";
import { getDb, schema } from "@/lib/db";
import { eq, and } from "drizzle-orm";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; entryId: string }> }
) {
  const { id, entryId } = await params;
  const db = getDb();
  db.delete(schema.credentialEntries)
    .where(and(
      eq(schema.credentialEntries.id, entryId),
      eq(schema.credentialEntries.credentialSetId, id)
    ))
    .run();
  return NextResponse.json({ ok: true });
}
