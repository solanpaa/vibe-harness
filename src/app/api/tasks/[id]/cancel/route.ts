import { NextRequest, NextResponse } from "next/server";
import { getDb, schema } from "@/lib/db";
import { eq } from "drizzle-orm";
import { cancelAcpOperation, getAcpSession } from "@/lib/services/acp-client";
import { transitionTask, transitionWorkflowRun } from "@/lib/state-machine";

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

  if (task.status !== "running" && task.status !== "provisioning") {
    return NextResponse.json(
      { error: "Task is not running or provisioning" },
      { status: 400 }
    );
  }

  const session = getAcpSession(id);
  if (!session) {
    // No ACP session yet (e.g. still provisioning) — transition state directly
    await transitionTask(id, { type: "CANCEL" });
    if (task.workflowRunId) {
      try {
        await transitionWorkflowRun(task.workflowRunId, { type: "CANCEL" });
      } catch {
        // Best effort — workflow may already be in a terminal state
      }
    }
    return NextResponse.json({ success: true });
  }

  const cancelled = cancelAcpOperation(id);
  if (!cancelled) {
    return NextResponse.json(
      { error: "Failed to cancel operation" },
      { status: 500 }
    );
  }

  // Transition the task state machine so it moves to cancelled
  await transitionTask(id, { type: "CANCEL" });
  if (task.workflowRunId) {
    try {
      await transitionWorkflowRun(task.workflowRunId, { type: "CANCEL" });
    } catch {
      // Best effort — workflow may already be in a terminal state
    }
  }

  return NextResponse.json({ success: true });
}
