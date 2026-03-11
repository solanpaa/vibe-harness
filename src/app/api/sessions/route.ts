import { NextRequest, NextResponse } from "next/server";
import { getDb, schema } from "@/lib/db";
import { v4 as uuid } from "uuid";

export async function GET() {
  const db = getDb();
  const allSessions = db.select().from(schema.sessions).all();
  return NextResponse.json(allSessions);
}

export async function POST(request: NextRequest) {
  const db = getDb();
  const body = await request.json();
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
  db.insert(schema.sessions).values(session).run();
  return NextResponse.json(session, { status: 201 });
}
