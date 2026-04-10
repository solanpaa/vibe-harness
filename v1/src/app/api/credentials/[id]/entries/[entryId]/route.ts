import { NextRequest, NextResponse } from "next/server";
import { getDb, schema } from "@/lib/db";
import { eq } from "drizzle-orm";
import { deleteCredentialEntry } from "@/lib/services/credential-vault";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; entryId: string }> }
) {
  const { id, entryId } = await params;
  const db = await getDb();
  const entry = await db
    .select()
    .from(schema.credentialEntries)
    .where(eq(schema.credentialEntries.id, entryId))
    .get();

  if (!entry || entry.credentialSetId !== id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({ ...entry, value: "***" });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; entryId: string }> }
) {
  const { entryId } = await params;
  deleteCredentialEntry(entryId);
  return NextResponse.json({ ok: true });
}
