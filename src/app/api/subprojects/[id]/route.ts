import { NextRequest, NextResponse } from "next/server";
import { getDb, schema } from "@/lib/db";
import { eq } from "drizzle-orm";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = getDb();
  const sub = db
    .select()
    .from(schema.subprojects)
    .where(eq(schema.subprojects.id, id))
    .get();
  if (!sub) {
    return NextResponse.json({ error: "Subproject not found" }, { status: 404 });
  }
  return NextResponse.json(sub);
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = getDb();
  const body = await request.json();
  db.update(schema.subprojects)
    .set(body)
    .where(eq(schema.subprojects.id, id))
    .run();
  const updated = db
    .select()
    .from(schema.subprojects)
    .where(eq(schema.subprojects.id, id))
    .get();
  return NextResponse.json(updated);
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = getDb();
  db.delete(schema.subprojects).where(eq(schema.subprojects.id, id)).run();
  return NextResponse.json({ ok: true });
}
