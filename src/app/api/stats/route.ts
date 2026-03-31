import { NextResponse } from "next/server";
import { getDb, schema } from "@/lib/db";
import { eq, desc } from "drizzle-orm";

export async function GET() {
  const db = await getDb();

  const projects = await db.select().from(schema.projects).all();
  const allTasks = await db.select().from(schema.tasks).all();
  const activeTasks = allTasks.filter((s) => s.status === "running" || s.status === "awaiting_review");
  const allReviews = await db.select().from(schema.reviews).all();
  const pendingReviews = allReviews.filter((s) => s.status === "pending_review");
  const workflowRuns = await db.select().from(schema.workflowRuns).all();
  const activeWorkflows = workflowRuns.filter(
    (w) => w.status === "running" || w.status === "awaiting_review"
  );

  const recentTasks = allTasks
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 5)
    .map((s) => ({
      ...s,
      projectName: projects.find((p) => p.id === s.projectId)?.name || "Unknown",
    }));

  return NextResponse.json({
    projectCount: projects.length,
    activeTaskCount: activeTasks.length,
    pendingReviewCount: pendingReviews.length,
    activeWorkflowCount: activeWorkflows.length,
    recentTasks,
    pendingReviews: pendingReviews
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 5),
  });
}
