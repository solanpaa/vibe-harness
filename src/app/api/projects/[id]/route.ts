import { NextRequest, NextResponse } from "next/server";
import { getDb, schema } from "@/lib/db";
import { eq } from "drizzle-orm";
import fs from "fs";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = getDb();
  const project = db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, id))
    .get();
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }
  return NextResponse.json(project);
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = getDb();
  const body = await request.json();

  if (body.localPath) {
    if (!fs.existsSync(body.localPath)) {
      return NextResponse.json(
        { error: `Directory does not exist: ${body.localPath}` },
        { status: 400 }
      );
    }
  }

  db.update(schema.projects)
    .set({ ...body, updatedAt: new Date().toISOString() })
    .where(eq(schema.projects.id, id))
    .run();
  const updated = db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, id))
    .get();
  return NextResponse.json(updated);
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = getDb();
  db.delete(schema.projects).where(eq(schema.projects.id, id)).run();
  return NextResponse.json({ ok: true });
}
