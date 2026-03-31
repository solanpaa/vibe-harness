import { NextRequest, NextResponse } from "next/server";
import { getDb, schema } from "@/lib/db";
import { eq } from "drizzle-orm";
import { cancelAcpOperation, getAcpSession } from "@/lib/services/acp-client";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = await getDb();

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

  const session = getAcpSession(id);
  if (!session) {
    return NextResponse.json(
      { error: "No ACP session found. Cancel is only supported for ACP tasks. Use stop to kill the task." },
      { status: 400 }
    );
  }

  const cancelled = cancelAcpOperation(id);
  if (!cancelled) {
    return NextResponse.json(
      { error: "Failed to cancel operation" },
      { status: 500 }
    );
  }

  return NextResponse.json({ success: true });
}
