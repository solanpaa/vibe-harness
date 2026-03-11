import { getDb, schema } from "@/lib/db";
import { eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { bundleCommentsAsPrompt, getOriginTaskId } from "./review-service";
import { startTask } from "./task-manager";

/**
 * Handle "request changes" on a review:
 * 1. Bundle inline comments into a structured prompt
 * 2. Run copilot --continue in the SAME sandbox with the feedback as prompt
 * 3. Create a new task record linked to the same worktree via originTaskId
 * 4. Task manager auto-creates review when the task completes (awaiting_review)
 */
export async function rerunWithComments(reviewId: string): Promise<{
  taskId: string;
  reviewRound: number;
} | null> {
  const db = getDb();

  const review = db
    .select()
    .from(schema.reviews)
    .where(eq(schema.reviews.id, reviewId))
    .get();
  if (!review) return null;

  const originalTask = db
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.id, review.taskId))
    .get();
  if (!originalTask) return null;

  const project = db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, originalTask.projectId))
    .get();
  if (!project) return null;

  const agent = db
    .select()
    .from(schema.agentDefinitions)
    .where(eq(schema.agentDefinitions.id, originalTask.agentDefinitionId))
    .get();
  if (!agent) return null;

  // Bundle comments into a prompt
  const commentPrompt = bundleCommentsAsPrompt(reviewId);
  const combinedPrompt = [
    "Please address these review comments on your previous changes:",
    "",
    commentPrompt,
  ].join("\n");

  // Track origin: if the original task already has an origin, use it;
  // otherwise, the original task IS the origin.
  const originId = getOriginTaskId(originalTask.id);

  // Create a new task record linked to the same chain
  const now = new Date().toISOString();
  const newTaskId = uuid();
  db.insert(schema.tasks)
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

  const agentCommand = agent.commandTemplate || "claude";

  // Use startTask which properly registers sandbox, creates worktree, etc.
  const sandbox = startTask({
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
  });

  // startTask auto-creates review on successful completion (awaiting_review)

  return {
    taskId: newTaskId,
    reviewRound: review.round + 1,
  };
}
