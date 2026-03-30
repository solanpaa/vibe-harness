/**
 * Workflow configuration helpers — pure functions for reading stage configs
 * and building prompts. Extracted as a leaf module to avoid circular
 * dependencies between state-machine, workflow-engine, and task-manager.
 */

import { getDb, schema } from "@/lib/db";
import { eq } from "drizzle-orm";
import type { WorkflowStage } from "@/types/domain";

/**
 * Look up the WorkflowStage config for a given workflow run and stage name.
 * Returns null for standalone tasks (no workflow) or if the stage isn't found.
 */
export function getStageConfig(
  workflowRunId: string,
  stageName: string
): WorkflowStage | null {
  const db = getDb();

  const run = db
    .select()
    .from(schema.workflowRuns)
    .where(eq(schema.workflowRuns.id, workflowRunId))
    .get();
  if (!run) return null;

  const template = db
    .select()
    .from(schema.workflowTemplates)
    .where(eq(schema.workflowTemplates.id, run.workflowTemplateId))
    .get();
  if (!template) return null;

  const stages: WorkflowStage[] = JSON.parse(template.stages);
  return stages.find((s) => s.name === stageName) ?? null;
}

/**
 * Get the next stage after the given stage name.
 * Returns null if the stage is not found or is the last stage.
 */
export function getNextStage(
  workflowRunId: string,
  currentStageName: string
): WorkflowStage | null {
  const db = getDb();

  const run = db
    .select()
    .from(schema.workflowRuns)
    .where(eq(schema.workflowRuns.id, workflowRunId))
    .get();
  if (!run) return null;

  const template = db
    .select()
    .from(schema.workflowTemplates)
    .where(eq(schema.workflowTemplates.id, run.workflowTemplateId))
    .get();
  if (!template) return null;

  const stages: WorkflowStage[] = JSON.parse(template.stages);
  const idx = stages.findIndex((s) => s.name === currentStageName);
  if (idx >= 0 && idx < stages.length - 1) return stages[idx + 1];

  // Dynamic stages (e.g., "split") aren't in the template — after
  // consolidation we want to proceed to the "commit" stage if it exists.
  if (idx === -1) {
    const commitStage = stages.find((s) => s.name === "commit");
    if (commitStage) return commitStage;
  }

  return null;
}

/**
 * Build a combined prompt from the task description and stage instructions.
 * When previousPlan is provided (fresh-session stages), it's injected as
 * context so the agent has the plan from the previous stage without
 * carrying over the full conversation history.
 */
export function buildStagePrompt(
  taskDescription: string,
  stage: WorkflowStage,
  previousPlan?: string | null
): string {
  if (!taskDescription?.trim()) {
    throw new Error("taskDescription is required for building stage prompt");
  }
  const parts = [`## Task`, taskDescription, ``];
  if (previousPlan) {
    parts.push(`## Context from Previous Stage`, previousPlan, ``);
  }
  parts.push(`## Current Stage: ${stage.name}`, stage.promptTemplate);
  return parts.join("\n");
}
