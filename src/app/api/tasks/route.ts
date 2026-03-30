import { NextRequest, NextResponse } from "next/server";
import { getDb, schema } from "@/lib/db";
import { v4 as uuid } from "uuid";
import { desc, eq } from "drizzle-orm";
import { generateTitle } from "@/lib/services/title-generator";

function safeParseUsageStats(raw: string | null): unknown {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export async function GET(request: NextRequest) {
  const db = getDb();
  const { searchParams } = new URL(request.url);

  // Lightweight listing for review grouping — omits large output field
  if (searchParams.get("fields") === "summary") {
    const rows = db
      .select({
        id: schema.tasks.id,
        projectId: schema.tasks.projectId,
        originTaskId: schema.tasks.originTaskId,
        workflowRunId: schema.tasks.workflowRunId,
        prompt: schema.tasks.prompt,
        status: schema.tasks.status,
        createdAt: schema.tasks.createdAt,
        usageStats: schema.tasks.usageStats,
      })
      .from(schema.tasks)
      .all();
    return NextResponse.json(rows.map(r => ({
      ...r,
      usageStats: safeParseUsageStats(r.usageStats),
    })));
  }

  // Enriched listing — tasks with related project, agent, workflow, and review data
  if (searchParams.get("include") === "enriched") {
    const rows = db
      .select({
        id: schema.tasks.id,
        projectId: schema.tasks.projectId,
        projectName: schema.projects.name,
        title: schema.tasks.title,
        agentName: schema.agentDefinitions.name,
        agentType: schema.agentDefinitions.type,
        workflowRunId: schema.tasks.workflowRunId,
        stageName: schema.tasks.stageName,
        originTaskId: schema.tasks.originTaskId,
        status: schema.tasks.status,
        prompt: schema.tasks.prompt,
        model: schema.tasks.model,
        sandboxId: schema.tasks.sandboxId,
        executionMode: schema.tasks.executionMode,
        comparisonGroupId: schema.tasks.comparisonGroupId,
        usageStats: schema.tasks.usageStats,
        createdAt: schema.tasks.createdAt,
        completedAt: schema.tasks.completedAt,
        wrTitle: schema.workflowRuns.title,
        wrCurrentStage: schema.workflowRuns.currentStage,
        wrStatus: schema.workflowRuns.status,
        wtName: schema.workflowTemplates.name,
        wtStages: schema.workflowTemplates.stages,
      })
      .from(schema.tasks)
      .innerJoin(schema.projects, eq(schema.tasks.projectId, schema.projects.id))
      .innerJoin(
        schema.agentDefinitions,
        eq(schema.tasks.agentDefinitionId, schema.agentDefinitions.id),
      )
      .leftJoin(
        schema.workflowRuns,
        eq(schema.tasks.workflowRunId, schema.workflowRuns.id),
      )
      .leftJoin(
        schema.workflowTemplates,
        eq(schema.workflowRuns.workflowTemplateId, schema.workflowTemplates.id),
      )
      .orderBy(desc(schema.tasks.createdAt))
      .all();

    // Build a map of taskId → all reviews (for timeline display)
    type ReviewInfo = { id: string; round: number; status: string; createdAt: string };
    const reviewsMap = new Map<string, ReviewInfo[]>();
    const allReviews = db
      .select({
        id: schema.reviews.id,
        taskId: schema.reviews.taskId,
        round: schema.reviews.round,
        status: schema.reviews.status,
        createdAt: schema.reviews.createdAt,
      })
      .from(schema.reviews)
      .all();
    for (const r of allReviews) {
      const list = reviewsMap.get(r.taskId) ?? [];
      list.push({ id: r.id, round: r.round, status: r.status, createdAt: r.createdAt });
      reviewsMap.set(r.taskId, list);
    }

    const enriched = rows.map((row) => {
      const reviews = reviewsMap.get(row.id) ?? [];
      const latestReview = reviews.length > 0
        ? reviews.reduce((best, r) => r.round > best.round ? r : best)
        : null;
      return {
      id: row.id,
      projectId: row.projectId,
      projectName: row.projectName,
      title: row.title,
      agentName: row.agentName,
      agentType: row.agentType,
      workflowRunId: row.workflowRunId,
      stageName: row.stageName,
      originTaskId: row.originTaskId,
      status: row.status,
      prompt: row.prompt,
      model: row.model,
      sandboxId: row.sandboxId,
      executionMode: row.executionMode,
      comparisonGroupId: row.comparisonGroupId,
      usageStats: safeParseUsageStats(row.usageStats),
      createdAt: row.createdAt,
      completedAt: row.completedAt,
      latestReview,
      reviews,
      workflow: row.workflowRunId && row.wtName
        ? {
            runId: row.workflowRunId,
            runTitle: row.wrTitle,
            templateName: row.wtName,
            currentStage: row.wrCurrentStage ?? "",
            runStatus: row.wrStatus ?? "unknown",
            stages: JSON.parse(row.wtStages ?? "[]") as Array<{
              name: string;
              promptTemplate: string;
              reviewRequired: boolean;
            }>,
          }
        : null,
      };
    });

    return NextResponse.json(enriched);
  }

  const allTasks = db.select().from(schema.tasks).all();
  return NextResponse.json(allTasks.map(t => ({
    ...t,
    usageStats: safeParseUsageStats(t.usageStats),
  })));
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

  const branch = body.branch || null;
  const now = new Date().toISOString();
  const task = {
    id: uuid(),
    projectId: body.projectId,
    workflowRunId: body.workflowRunId || null,
    stageName: body.stageName || null,
    agentDefinitionId: body.agentDefinitionId,
    credentialSetId: body.credentialSetId || null,
    sandboxId: null,
    originTaskId: body.originTaskId || null,
    status: "pending" as const,
    prompt: body.prompt,
    model: body.model || null,
    useWorktree: body.useWorktree !== false ? 1 : 0,
    branch: branch,
    targetBranch: branch,
    output: null,
    createdAt: now,
    completedAt: null,
  };

  try {
    db.insert(schema.tasks).values(task).run();
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Failed to create task";
    return NextResponse.json({ error: message }, { status: 500 });
  }

  // Fire-and-forget title generation
  generateTitle(task.prompt).then((title) => {
    if (title) {
      db.update(schema.tasks)
        .set({ title })
        .where(eq(schema.tasks.id, task.id))
        .run();
    }
  }).catch(() => {});

  return NextResponse.json(task, { status: 201 });
}
