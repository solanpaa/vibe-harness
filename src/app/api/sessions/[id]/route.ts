import { NextRequest, NextResponse } from "next/server";
import { getDb, schema } from "@/lib/db";
import { eq } from "drizzle-orm";
import { startSession, stopSession } from "@/lib/services/session-manager";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = getDb();
  const session = db
    .select()
    .from(schema.sessions)
    .where(eq(schema.sessions.id, id))
    .get();
  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }
  return NextResponse.json(session);
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = getDb();
  const body = await request.json();

  // Handle start/stop actions
  if (body.action === "start") {
    const session = db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.id, id))
      .get();
    if (!session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const project = db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, session.projectId))
      .get();
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const agent = db
      .select()
      .from(schema.agentDefinitions)
      .where(eq(schema.agentDefinitions.id, session.agentDefinitionId))
      .get();
    if (!agent) {
      return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    }

    const agentCommand =
      agent.commandTemplate || "claude";

    try {
      startSession({
        sessionId: id,
        projectDir: project.localPath,
        agentCommand,
        credentialSetId: session.credentialSetId,
        dockerImage: agent.dockerImage,
        prompt: session.prompt,
        model: session.model,
        useWorktree: session.useWorktree === 1,
      });
      const updated = db
        .select()
        .from(schema.sessions)
        .where(eq(schema.sessions.id, id))
        .get();
      return NextResponse.json(updated);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Failed to start session";
      return NextResponse.json({ error: message }, { status: 500 });
    }
  }

  if (body.action === "stop") {
    stopSession(id);
    const updated = db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.id, id))
      .get();
    return NextResponse.json(updated);
  }

  // Generic update
  db.update(schema.sessions)
    .set(body)
    .where(eq(schema.sessions.id, id))
    .run();
  const updated = db
    .select()
    .from(schema.sessions)
    .where(eq(schema.sessions.id, id))
    .get();
  return NextResponse.json(updated);
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = getDb();
  db.delete(schema.sessions).where(eq(schema.sessions.id, id)).run();
  return NextResponse.json({ ok: true });
}
