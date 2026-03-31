import { NextRequest, NextResponse } from "next/server";
import { getDb, schema } from "@/lib/db";
import { eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";

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

  // Check if any tasks reference this credential set before deleting
  const referencingTasks = db
    .select({ id: schema.tasks.id })
    .from(schema.tasks)
    .where(eq(schema.tasks.credentialSetId, id))
    .all();

  if (referencingTasks.length > 0) {
    return NextResponse.json(
      { error: `Credential set is referenced by ${referencingTasks.length} task(s)` },
      { status: 409 }
    );
  }

  const credSet = db.select().from(schema.credentialSets)
    .where(eq(schema.credentialSets.id, id)).get();

  // Cascade: delete entries first
  db.delete(schema.credentialEntries)
    .where(eq(schema.credentialEntries.credentialSetId, id))
    .run();
  db.delete(schema.credentialSets)
    .where(eq(schema.credentialSets.id, id))
    .run();

  // Audit log
  db.insert(schema.credentialAuditLog).values({
    id: uuid(),
    action: "delete_set",
    credentialSetId: id,
    details: JSON.stringify({ name: credSet?.name }),
    createdAt: new Date().toISOString(),
  }).run();

  return NextResponse.json({ ok: true });
}
