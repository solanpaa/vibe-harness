import { NextRequest, NextResponse } from "next/server";
import { getDb, schema } from "@/lib/db";
import { v4 as uuid } from "uuid";
import { eq } from "drizzle-orm";

export async function GET(request: NextRequest) {
  const db = getDb();
  const { searchParams } = new URL(request.url);

  // Lightweight listing for review grouping — omits large output field
  if (searchParams.get("fields") === "summary") {
    const rows = db
      .select({
        id: schema.tasks.id,
        projectId: schema.tasks.projectId,
        originTaskId: schema.tasks.originTaskId,
        prompt: schema.tasks.prompt,
        status: schema.tasks.status,
        createdAt: schema.tasks.createdAt,
      })
      .from(schema.tasks)
      .all();
    return NextResponse.json(rows);
  }

  const allTasks = db.select().from(schema.tasks).all();
  return NextResponse.json(allTasks);
}

export async function POST(request: NextRequest) {
  const db = getDb();
  const body = await request.json();

  // Validate foreign keys exist
  const project = db.select().from(schema.projects).where(eq(schema.projects.id, body.projectId)).get();
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 400 });
  }
  const agent = db.select().from(schema.agentDefinitions).where(eq(schema.agentDefinitions.id, body.agentDefinitionId)).get();
  if (!agent) {
    return NextResponse.json({ error: "Agent definition not found" }, { status: 400 });
  }

  const now = new Date().toISOString();
  const task = {
    id: uuid(),
    projectId: body.projectId,
    workflowRunId: body.workflowRunId || null,
    stageName: body.stageName || null,
    agentDefinitionId: body.agentDefinitionId,
    credentialSetId: body.credentialSetId || null,
    sandboxId: null,
    originTaskId: body.originTaskId || null,
    status: "pending" as const,
    prompt: body.prompt,
    model: body.model || null,
    useWorktree: body.useWorktree !== false ? 1 : 0,
    output: null,
    createdAt: now,
    completedAt: null,
  };

  try {
    db.insert(schema.tasks).values(task).run();
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Failed to create task";
    return NextResponse.json({ error: message }, { status: 500 });
  }
  return NextResponse.json(task, { status: 201 });
}
