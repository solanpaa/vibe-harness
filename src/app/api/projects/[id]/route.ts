import { NextRequest, NextResponse } from "next/server";
import { getDb, schema } from "@/lib/db";
import { eq, sql } from "drizzle-orm";
import fs from "fs";
import { execFileSync } from "child_process";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = await getDb();
  const project = await db
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
  const db = await getDb();
  const body = await request.json();

  if (body.localPath) {
    if (!fs.existsSync(body.localPath)) {
      return NextResponse.json(
        { error: `Directory does not exist: ${body.localPath}` },
        { status: 400 }
      );
    }

    if (!fs.statSync(body.localPath).isDirectory()) {
      return NextResponse.json(
        { error: "Path is not a git repository" },
        { status: 400 }
      );
    }

    try {
      const result = execFileSync(
        "git",
        ["-C", body.localPath, "rev-parse", "--is-inside-work-tree"],
        { stdio: "pipe" }
      );
      if (result.toString().trim() !== "true") {
        return NextResponse.json(
          { error: "Path is not a git repository" },
          { status: 400 }
        );
      }
    } catch {
      return NextResponse.json(
        { error: "Path is not a git repository" },
        { status: 400 }
      );
    }
  }

  await db.update(schema.projects)
    .set({ ...body, updatedAt: new Date().toISOString() })
    .where(eq(schema.projects.id, id))
    .run();
  const updated = await db
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
  const db = await getDb();

  const [taskCount, workflowRunCount, comparisonGroupCount] = await Promise.all([
    db.select({ count: sql<number>`count(*)` }).from(schema.tasks).where(eq(schema.tasks.projectId, id)).get(),
    db.select({ count: sql<number>`count(*)` }).from(schema.workflowRuns).where(eq(schema.workflowRuns.projectId, id)).get(),
    db.select({ count: sql<number>`count(*)` }).from(schema.comparisonGroups).where(eq(schema.comparisonGroups.projectId, id)).get(),
  ]);

  if ((taskCount?.count ?? 0) > 0 || (workflowRunCount?.count ?? 0) > 0 || (comparisonGroupCount?.count ?? 0) > 0) {
    return NextResponse.json(
      { error: "Cannot delete project with existing tasks or workflows. Delete them first." },
      { status: 409 }
    );
  }

  await db.delete(schema.projects).where(eq(schema.projects.id, id)).run();
  return NextResponse.json({ ok: true });
}
