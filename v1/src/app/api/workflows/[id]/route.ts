import { NextRequest, NextResponse } from "next/server";
import { getDb, schema } from "@/lib/db";
import { eq } from "drizzle-orm";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = await getDb();
  const template = await db
    .select()
    .from(schema.workflowTemplates)
    .where(eq(schema.workflowTemplates.id, id))
    .get();
  if (!template) {
    return NextResponse.json({ error: "Workflow not found" }, { status: 404 });
  }
  return NextResponse.json({ ...template, stages: JSON.parse(template.stages) });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = await getDb();
  const body = await request.json();

  const existing = await db
    .select()
    .from(schema.workflowTemplates)
    .where(eq(schema.workflowTemplates.id, id))
    .get();
  if (!existing) {
    return NextResponse.json({ error: "Workflow not found" }, { status: 404 });
  }

  const updates: Record<string, string> = {
    updatedAt: new Date().toISOString(),
  };
  if (body.name !== undefined) updates.name = body.name;
  if (body.description !== undefined) updates.description = body.description;
  if (body.stages !== undefined) updates.stages = JSON.stringify(body.stages);

  await db.update(schema.workflowTemplates)
    .set(updates)
    .where(eq(schema.workflowTemplates.id, id))
    .run();

  const updated = await db
    .select()
    .from(schema.workflowTemplates)
    .where(eq(schema.workflowTemplates.id, id))
    .get();

  return NextResponse.json({ ...updated!, stages: JSON.parse(updated!.stages) });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = await getDb();
  await db.delete(schema.workflowTemplates)
    .where(eq(schema.workflowTemplates.id, id))
    .run();
  return NextResponse.json({ ok: true });
}
