import { getDb, schema } from "@/lib/db";
import { eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { listProposals } from "./proposal-service";
import { startWorkflowRun, createWorkflowTemplate } from "./workflow-engine";
import type { WorkflowStage } from "@/types/domain";

const MAX_CONCURRENT = 10;

/**
 * Get or create the "Implement & Review" template used for sub-task runs.
 */
function getOrCreateSubTaskTemplate(): string {
  const db = getDb();
  const existing = db
    .select()
    .from(schema.workflowTemplates)
    .all()
    .find((t) => t.name === "Implement & Review (Sub-task)");

  if (existing) return existing.id;

  const stages: WorkflowStage[] = [
    {
      name: "implement",
      type: "sequential" as const,
      promptTemplate: `Implement the changes described below. Follow the project's existing style and conventions.

Guidelines:
- Implement exactly what is described — no more, no less.
- Match existing code patterns and naming conventions.
- Handle error cases and edge cases appropriately.
- Verify the build passes after your changes.
- Do not commit.`,
      autoAdvance: false,
      reviewRequired: true,
      freshSession: false,
    },
  ];

  const template = createWorkflowTemplate({
    name: "Implement & Review (Sub-task)",
    description:
      "Single-stage workflow for parallel sub-task execution. Each sub-task implements one piece of a larger plan.",
    stages,
  });

  return template.id;
}

/**
 * Build the prompt for a sub-task from its proposal + parent context.
 */
function buildSubTaskPrompt(
  proposal: { title: string; description: string; affectedFiles: string[] },
  planContext: string | null,
  parentTaskDescription: string | null
): string {
  const parts: string[] = [];

  if (parentTaskDescription) {
    parts.push(`## Overall Task\n${parentTaskDescription}`);
  }

  if (planContext) {
    parts.push(`## Implementation Plan (from planning stage)\n${planContext}`);
  }

  parts.push(`## Your Assignment: ${proposal.title}\n${proposal.description}`);

  if (proposal.affectedFiles.length > 0) {
    parts.push(
      `## Files to Modify\n${proposal.affectedFiles.map((f) => `- ${f}`).join("\n")}`
    );
  }

  return parts.join("\n\n");
}

/**
 * Launch proposals as parallel workflow runs.
 * Creates a parallel group and kicks off independent workflow runs.
 */
export async function launchProposals(input: {
  taskId: string;
  proposalIds?: string[];
  workflowTemplateId?: string;
}): Promise<{
  parallelGroupId: string;
  workflowRunIds: string[];
  launched: number;
  queued: number;
}> {
  const db = getDb();

  // Get the split task
  const splitTask = db
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.id, input.taskId))
    .get();

  if (!splitTask) throw new Error("Task not found");

  // Get proposals
  const allProposals = listProposals(input.taskId);
  const proposals = input.proposalIds
    ? allProposals.filter((p) => input.proposalIds!.includes(p.id))
    : allProposals.filter((p) => p.status !== "discarded");

  if (proposals.length === 0) {
    throw new Error("No proposals to launch");
  }

  // Get plan context from the workflow run's previous reviews
  let planContext: string | null = null;
  if (splitTask.workflowRunId) {
    const reviews = db
      .select()
      .from(schema.reviews)
      .where(eq(schema.reviews.workflowRunId, splitTask.workflowRunId))
      .all();
    // Use the first review's plan (from the plan stage)
    planContext =
      reviews.find((r) => r.planMarkdown)?.planMarkdown ||
      reviews.find((r) => r.aiSummary)?.aiSummary ||
      null;
  }

  // Get parent workflow run for context
  const parentRun = splitTask.workflowRunId
    ? db
        .select()
        .from(schema.workflowRuns)
        .where(eq(schema.workflowRuns.id, splitTask.workflowRunId))
        .get()
    : null;

  // Get or create the sub-task template
  const templateId =
    input.workflowTemplateId || getOrCreateSubTaskTemplate();

  // Create parallel group
  const now = new Date().toISOString();
  const groupId = uuid();
  db.insert(schema.parallelGroups)
    .values({
      id: groupId,
      sourceWorkflowRunId: splitTask.workflowRunId || splitTask.id,
      name: parentRun?.title || `Parallel: ${splitTask.prompt.slice(0, 50)}`,
      description: `${proposals.length} sub-tasks from split stage`,
      status: "running",
      createdAt: now,
    })
    .run();

  // Build dependency graph to determine launch order
  const proposalMap = new Map(proposals.map((p) => [p.title, p]));
  const readyToLaunch: typeof proposals = [];
  const queued: typeof proposals = [];

  for (const p of proposals) {
    const hasDeps =
      p.dependsOn.length > 0 &&
      p.dependsOn.some((dep: string) => proposalMap.has(dep));
    if (hasDeps) {
      queued.push(p);
    } else {
      readyToLaunch.push(p);
    }
  }

  // Get the agent definition from the split task
  const agentId = splitTask.agentDefinitionId;

  // Launch ready proposals (up to MAX_CONCURRENT)
  const workflowRunIds: string[] = [];
  const toLaunch = readyToLaunch.slice(0, MAX_CONCURRENT);
  const overflow = readyToLaunch.slice(MAX_CONCURRENT);

  for (const proposal of toLaunch) {
    const prompt = buildSubTaskPrompt(
      proposal,
      planContext,
      parentRun?.taskDescription || null
    );

    try {
      const result = await startWorkflowRun({
        workflowTemplateId: templateId,
        projectId: splitTask.projectId,
        taskDescription: prompt,
        agentDefinitionId: agentId,
        credentialSetId: splitTask.credentialSetId,
        model: splitTask.model,
        useWorktree: true,
      });

      workflowRunIds.push(result.runId);

      // Link the workflow run to the parallel group and proposal
      db.update(schema.workflowRuns)
        .set({
          parallelGroupId: groupId,
          sourceProposalId: proposal.id,
        })
        .where(eq(schema.workflowRuns.id, result.runId))
        .run();

      // Update proposal status
      db.update(schema.taskProposals)
        .set({
          status: "launched",
          parallelGroupId: groupId,
          launchedWorkflowRunId: result.runId,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(schema.taskProposals.id, proposal.id))
        .run();
    } catch (e) {
      console.error(`Failed to launch proposal "${proposal.title}":`, e);
    }
  }

  // Mark overflow and dependency-blocked proposals as approved (queued)
  for (const p of [...overflow, ...queued]) {
    db.update(schema.taskProposals)
      .set({
        status: "approved",
        parallelGroupId: groupId,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.taskProposals.id, p.id))
      .run();
  }

  return {
    parallelGroupId: groupId,
    workflowRunIds,
    launched: toLaunch.length,
    queued: overflow.length + queued.length,
  };
}

/**
 * Get aggregated status for a parallel group.
 */
export function getParallelGroupStatus(groupId: string) {
  const db = getDb();

  const group = db
    .select()
    .from(schema.parallelGroups)
    .where(eq(schema.parallelGroups.id, groupId))
    .get();

  if (!group) return null;

  const childRuns = db
    .select({ status: schema.workflowRuns.status })
    .from(schema.workflowRuns)
    .where(eq(schema.workflowRuns.parallelGroupId, groupId))
    .all();

  const total = childRuns.length;
  const completed = childRuns.filter((r) => r.status === "completed").length;
  const failed = childRuns.filter((r) => r.status === "failed").length;

  return {
    ...group,
    total,
    completed,
    failed,
    allDone: total > 0 && completed + failed === total,
    allSucceeded: total > 0 && completed === total,
  };
}
