import { NextRequest, NextResponse } from "next/server";
import { getDb, schema } from "@/lib/db";
import { v4 as uuid } from "uuid";
import { eq } from "drizzle-orm";

export async function GET() {
  const db = getDb();
  const allSessions = db.select().from(schema.sessions).all();
  return NextResponse.json(allSessions);
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
  const session = {
    id: uuid(),
    projectId: body.projectId,
    subprojectId: body.subprojectId || null,
    workflowRunId: body.workflowRunId || null,
    stageName: body.stageName || null,
    agentDefinitionId: body.agentDefinitionId,
    credentialSetId: body.credentialSetId || null,
    sandboxId: null,
    status: "pending" as const,
    prompt: body.prompt,
    output: null,
    createdAt: now,
    completedAt: null,
  };

  try {
    db.insert(schema.sessions).values(session).run();
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Failed to create session";
    return NextResponse.json({ error: message }, { status: 500 });
  }
  return NextResponse.json(session, { status: 201 });
}
