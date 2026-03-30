import { NextRequest, NextResponse } from "next/server";
import { getDb, schema } from "@/lib/db";
import { eq } from "drizzle-orm";
import { transitionTask } from "@/lib/state-machine";
import { finalizeAndMerge, stopTask } from "@/lib/services/task-manager";
import { removeWorktree } from "@/lib/services/worktree";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = getDb();

  const group = db
    .select()
    .from(schema.comparisonGroups)
    .where(eq(schema.comparisonGroups.id, id))
    .get();

  if (!group) {
    return NextResponse.json(
      { error: "Comparison group not found" },
      { status: 404 }
    );
  }

  const tasks = db
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.comparisonGroupId, id))
    .all();

  // Enrich tasks with agent info and review data
  const enrichedTasks = tasks.map((task) => {
    const agent = db
      .select()
      .from(schema.agentDefinitions)
      .where(eq(schema.agentDefinitions.id, task.agentDefinitionId))
      .get();

    const review = db
      .select()
      .from(schema.reviews)
      .where(eq(schema.reviews.taskId, task.id))
      .get();

    let diffStats = null;
    if (review?.diffSnapshot) {
      const lines = review.diffSnapshot.split("\n");
      let additions = 0;
      let deletions = 0;
      let filesChanged = 0;
      const files = new Set<string>();

      for (const line of lines) {
        if (line.startsWith("+++ b/")) {
          files.add(line.slice(6));
        } else if (line.startsWith("+") && !line.startsWith("+++")) {
          additions++;
        } else if (line.startsWith("-") && !line.startsWith("---")) {
          deletions++;
        }
      }
      filesChanged = files.size;
      diffStats = { filesChanged, additions, deletions };
    }

    const usageStats = task.usageStats
      ? JSON.parse(task.usageStats)
      : null;

    const duration =
      task.createdAt && task.completedAt
        ? new Date(task.completedAt).getTime() -
          new Date(task.createdAt).getTime()
        : null;

    return {
      id: task.id,
      agentName: agent?.name ?? "Unknown",
      agentType: agent?.type ?? "unknown",
      model: task.model,
      status: task.status,
      executionMode: task.executionMode,
      duration,
      usageStats,
      lastAiMessage: task.lastAiMessage,
      reviewId: review?.id ?? null,
      reviewStatus: review?.status ?? null,
      diffStats,
    };
  });

  return NextResponse.json({
    ...group,
    tasks: enrichedTasks,
  });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = getDb();
  const body = await request.json();

  // Pick winner action
  if (body.action === "pick_winner") {
    const { winnerTaskId } = body;
    if (!winnerTaskId) {
      return NextResponse.json(
        { error: "winnerTaskId is required" },
        { status: 400 }
      );
    }

    const group = db
      .select()
      .from(schema.comparisonGroups)
      .where(eq(schema.comparisonGroups.id, id))
      .get();
    if (!group) {
      return NextResponse.json(
        { error: "Comparison group not found" },
        { status: 404 }
      );
    }

    if (group.status === "completed") {
      return NextResponse.json(
        { error: "Comparison group already completed" },
        { status: 409 }
      );
    }

    const project = db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, group.projectId))
      .get();

    const tasks = db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.comparisonGroupId, id))
      .all();

    const winnerTask = tasks.find((t) => t.id === winnerTaskId);
    if (!winnerTask) {
      return NextResponse.json(
        { error: "Winner task not in this comparison group" },
        { status: 400 }
      );
    }

    // Stop/complete running task BEFORE merging
    if (winnerTask.status === "running") {
      await transitionTask(winnerTaskId, { type: "COMPLETE" });
    }

    // Now safe to merge
    let mergeResult: { merged: boolean; branch: string; error?: string } = { merged: false, branch: "" };
    if (project) {
      try {
        mergeResult = finalizeAndMerge(winnerTaskId);
      } catch (e) {
        console.error("Failed to merge winner:", e);
      }
    }

    // Stop running losers and clean up their worktrees
    for (const task of tasks) {
      if (task.id === winnerTaskId) continue;

      if (task.status === "running") {
        await stopTask(task.id);
      }

      // Mark non-terminal losers as cancelled
      if (task.status !== "completed" && task.status !== "failed" && task.status !== "cancelled") {
        await transitionTask(task.id, { type: "CANCEL" });
      }

      // Clean up loser worktrees
      if (project) {
        try {
          removeWorktree(project.localPath, task.id);
        } catch {
          // Non-critical
        }
      }
    }

    // Mark group as completed
    db.update(schema.comparisonGroups)
      .set({ status: "completed", completedAt: new Date().toISOString() })
      .where(eq(schema.comparisonGroups.id, id))
      .run();

    return NextResponse.json({
      status: "completed",
      winnerTaskId,
      merged: mergeResult.merged,
      mergeError: mergeResult.error,
    });
  }

  // Generic update
  const { action, ...updates } = body;
  if (Object.keys(updates).length > 0) {
    db.update(schema.comparisonGroups)
      .set(updates)
      .where(eq(schema.comparisonGroups.id, id))
      .run();
  }

  const updated = db
    .select()
    .from(schema.comparisonGroups)
    .where(eq(schema.comparisonGroups.id, id))
    .get();

  return NextResponse.json(updated);
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = getDb();

  // Stop and delete all tasks in the group
  const tasks = db
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.comparisonGroupId, id))
    .all();

  for (const task of tasks) {
    if (task.status === "running") {
      await stopTask(task.id);
    }
    db.delete(schema.tasks).where(eq(schema.tasks.id, task.id)).run();
  }

  db.delete(schema.comparisonGroups)
    .where(eq(schema.comparisonGroups.id, id))
    .run();

  return NextResponse.json({ ok: true });
}
