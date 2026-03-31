import { getDb, schema } from "@/lib/db";
import { eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { bundleCommentsAsPrompt, getOriginTaskId } from "./review-service";
import { startTask, getTransitionTask } from "./task-manager";
import { buildStagePrompt, getStageConfig } from "./workflow-config";

/**
 * Handle "request changes" on a review:
 * 1. Build a stage-aware prompt that includes original task context + review feedback
 * 2. Resume the existing ACP session in the SAME sandbox via loadSessionId
 * 3. Create a new task record linked to the same worktree via originTaskId
 * 4. Update workflow run status to "running"
 * 5. Task manager auto-creates review when the task completes (awaiting_review)
 */
export async function rerunWithComments(reviewId: string): Promise<{
  taskId: string;
  reviewRound: number;
} | null> {
  const db = await getDb();

  const review = await db
    .select()
    .from(schema.reviews)
    .where(eq(schema.reviews.id, reviewId))
    .get();
  if (!review) return null;

  const originalTask = await db
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.id, review.taskId))
    .get();
  if (!originalTask) return null;

  const terminalStatuses = ["completed", "failed", "cancelled"];
  if (!terminalStatuses.includes(originalTask.status)) {
    console.warn(`[rerunWithComments] Original task ${originalTask.id} is still in status "${originalTask.status}", skipping rerun`);
    return null;
  }

  const project = await db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, originalTask.projectId))
    .get();
  if (!project) return null;

  const agent = await db
    .select()
    .from(schema.agentDefinitions)
    .where(eq(schema.agentDefinitions.id, originalTask.agentDefinitionId))
    .get();
  if (!agent) return null;

  // Bundle review comments
  const commentPrompt = await bundleCommentsAsPrompt(reviewId);
  if (!commentPrompt || commentPrompt.trim() === "") {
    console.warn(`[rerunWithComments] No comments found for review ${reviewId}, skipping rerun`);
    return null;
  }

  // Build stage-aware prompt when this task is part of a workflow
  let combinedPrompt: string;
  if (originalTask.workflowRunId && originalTask.stageName) {
    const run = await db
      .select()
      .from(schema.workflowRuns)
      .where(eq(schema.workflowRuns.id, originalTask.workflowRunId))
      .get();

    const stageConfig = await getStageConfig(originalTask.workflowRunId, originalTask.stageName);

    if (run && stageConfig) {
      const basePrompt = buildStagePrompt(
        run.taskDescription || originalTask.prompt,
        stageConfig,
      );
      combinedPrompt = [
        basePrompt,
        ``,
        `## Review Feedback (Round ${review.round + 1})`,
        commentPrompt,
        ``,
        `Important: Address the review feedback above while staying within the scope of the "${originalTask.stageName}" stage.`,
      ].join("\n");
    } else {
      combinedPrompt = [
        "Please address these review comments on your previous changes:",
        "",
        commentPrompt,
      ].join("\n");
    }
  } else {
    combinedPrompt = [
      "Please address these review comments on your previous changes:",
      "",
      commentPrompt,
    ].join("\n");
  }

  // Track origin: if the original task already has an origin, use it;
  // otherwise, the original task IS the origin.
  const originId = await getOriginTaskId(originalTask.id);

  // Get ACP session ID for session continuation
  let loadSessionId: string | null = null;
  if (originalTask.workflowRunId) {
    const run = await db
      .select({ acpSessionId: schema.workflowRuns.acpSessionId })
      .from(schema.workflowRuns)
      .where(eq(schema.workflowRuns.id, originalTask.workflowRunId))
      .get();
    loadSessionId = run?.acpSessionId || null;
  }

  // Create a new task record linked to the same chain
  const now = new Date().toISOString();
  const newTaskId = uuid();
  await db.insert(schema.tasks)
    .values({
      id: newTaskId,
      projectId: originalTask.projectId,
      workflowRunId: originalTask.workflowRunId,
      stageName: originalTask.stageName,
      agentDefinitionId: originalTask.agentDefinitionId,
      credentialSetId: originalTask.credentialSetId,
      sandboxId: null,
      originTaskId: originId,
      status: "pending",
      prompt: combinedPrompt,
      model: originalTask.model,
      useWorktree: originalTask.useWorktree,
      output: null,
      createdAt: now,
      completedAt: null,
    })
    .run();

  // Workflow run status transition to "running" is handled by the state machine
  // (REQUEST_CHANGES event). No direct DB update needed here.

  const agentCommand = agent.commandTemplate || "claude";

  // Transition to provisioning before launching
  await getTransitionTask()(newTaskId, { type: "PROVISION" });

  // Use startTask which properly registers sandbox, creates worktree, etc.
  startTask({
    taskId: newTaskId,
    projectDir: project.localPath,
    agentCommand,
    credentialSetId: originalTask.credentialSetId,
    dockerImage: agent.dockerImage,
    prompt: combinedPrompt,
    model: originalTask.model,
    useWorktree: originalTask.useWorktree === 1,
    isContinuation: true,
    originTaskId: originId,
    loadSessionId,
  });

  return {
    taskId: newTaskId,
    reviewRound: review.round + 1,
  };
}
