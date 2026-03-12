import { NextRequest, NextResponse } from "next/server";
import { getDb, schema } from "@/lib/db";
import { eq } from "drizzle-orm";
import { sendAcpPrompt, getAcpSession } from "@/lib/services/acp-client";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await request.json();
  const { message, context } = body;

  if (!message || typeof message !== "string") {
    return NextResponse.json(
      { error: "message is required" },
      { status: 400 }
    );
  }

  const db = getDb();
  const task = db
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.id, id))
    .get();

  if (!task) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  if (task.status !== "running") {
    return NextResponse.json(
      { error: "Task is not running" },
      { status: 400 }
    );
  }

  // Send via ACP
  const acpSession = getAcpSession(id);
  if (!acpSession) {
    return NextResponse.json(
      { error: "No active session for this task" },
      { status: 400 }
    );
  }

  const result = await sendAcpPrompt(id, message);
  if (!result.success) {
    return NextResponse.json(
      { error: "Failed to send message to agent" },
      { status: 500 }
    );
  }

  // Persist the intervention message
  const messageId = crypto.randomUUID();
  db.insert(schema.taskMessages)
    .values({
      id: messageId,
      taskId: id,
      role: "user",
      content: message,
      isIntervention: 1,
      metadata: context ? JSON.stringify({ context }) : null,
      createdAt: new Date().toISOString(),
    })
    .run();

  return NextResponse.json({ success: true, messageId });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = getDb();

  const messages = db
    .select()
    .from(schema.taskMessages)
    .where(eq(schema.taskMessages.taskId, id))
    .all();

  return NextResponse.json(messages);
}
