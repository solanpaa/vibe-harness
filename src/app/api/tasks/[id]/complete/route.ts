import { NextRequest, NextResponse } from "next/server";
import { getDb, schema } from "@/lib/db";
import { eq } from "drizzle-orm";
import { completeAcpSession, cancelAutoComplete } from "@/lib/services/acp-client";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = await getDb();
  // Intentionally fall back to {} for internal callers that may not send a body
  const body = await request.json().catch(() => ({}));

  const task = await db
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

  // If action is "cancel_auto_complete", just cancel the timer
  if (body.action === "cancel_auto_complete") {
    const cancelled = cancelAutoComplete(id);
    return NextResponse.json({ success: cancelled });
  }

  // Default: complete the stage — close session to trigger review
  const closed = completeAcpSession(id);
  if (!closed) {
    return NextResponse.json(
      { error: "No active session to complete" },
      { status: 400 }
    );
  }

  return NextResponse.json({ success: true });
}
