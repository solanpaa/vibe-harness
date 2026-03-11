import { NextResponse } from "next/server";
import { getDb, schema } from "@/lib/db";
import { eq, desc } from "drizzle-orm";

export async function GET() {
  const db = getDb();

  const projects = db.select().from(schema.projects).all();
  const allSessions = db.select().from(schema.sessions).all();
  const activeSessions = allSessions.filter((s) => s.status === "running");
  const allReviews = db.select().from(schema.reviews).all();
  const pendingReviews = allReviews.filter((s) => s.status === "pending_review");
  const workflowRuns = db.select().from(schema.workflowRuns).all();
  const activeWorkflows = workflowRuns.filter(
    (w) => w.status === "running" || w.status === "awaiting_review"
  );

  const recentSessions = allSessions
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 5)
    .map((s) => ({
      ...s,
      projectName: projects.find((p) => p.id === s.projectId)?.name || "Unknown",
    }));

  return NextResponse.json({
    projectCount: projects.length,
    activeSessionCount: activeSessions.length,
    pendingReviewCount: pendingReviews.length,
    activeWorkflowCount: activeWorkflows.length,
    recentSessions,
    pendingReviews: pendingReviews
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 5),
  });
}
