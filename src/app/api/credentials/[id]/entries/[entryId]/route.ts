import { NextRequest, NextResponse } from "next/server";
import { getDb, schema } from "@/lib/db";
import { eq } from "drizzle-orm";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; entryId: string }> }
) {
  const { entryId } = await params;
  const db = getDb();
  db.delete(schema.credentialEntries)
    .where(eq(schema.credentialEntries.id, entryId))
    .run();
  return NextResponse.json({ ok: true });
}
