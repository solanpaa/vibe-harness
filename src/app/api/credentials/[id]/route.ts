import { NextRequest, NextResponse } from "next/server";
import { getDb, schema } from "@/lib/db";
import { eq } from "drizzle-orm";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = getDb();
  const credSet = db
    .select()
    .from(schema.credentialSets)
    .where(eq(schema.credentialSets.id, id))
    .get();
  if (!credSet) {
    return NextResponse.json({ error: "Credential set not found" }, { status: 404 });
  }
  return NextResponse.json(credSet);
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = getDb();
  // Cascade: delete entries first
  db.delete(schema.credentialEntries)
    .where(eq(schema.credentialEntries.credentialSetId, id))
    .run();
  db.delete(schema.credentialSets)
    .where(eq(schema.credentialSets.id, id))
    .run();
  return NextResponse.json({ ok: true });
}
