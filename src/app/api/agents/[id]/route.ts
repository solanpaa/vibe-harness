import { NextRequest, NextResponse } from "next/server";
import { getDb, schema } from "@/lib/db";
import { eq } from "drizzle-orm";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = getDb();
  const agent = db
    .select()
    .from(schema.agentDefinitions)
    .where(eq(schema.agentDefinitions.id, id))
    .get();
  if (!agent) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }
  return NextResponse.json(agent);
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = getDb();
  const body = await request.json();

  const existing = db
    .select()
    .from(schema.agentDefinitions)
    .where(eq(schema.agentDefinitions.id, id))
    .get();
  if (!existing) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  const { id: _id, createdAt: _ca, ...updateFields } = body;
  db.update(schema.agentDefinitions)
    .set(updateFields)
    .where(eq(schema.agentDefinitions.id, id))
    .run();

  const updated = db
    .select()
    .from(schema.agentDefinitions)
    .where(eq(schema.agentDefinitions.id, id))
    .get();
  return NextResponse.json(updated);
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = getDb();
  db.delete(schema.agentDefinitions)
    .where(eq(schema.agentDefinitions.id, id))
    .run();
  return NextResponse.json({ ok: true });
}
