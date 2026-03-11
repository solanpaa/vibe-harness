import { getDb, schema } from "@/lib/db";
import { eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { bundleCommentsAsPrompt } from "./review-service";
import { startSession } from "./session-manager";

/**
 * Handle "request changes" on a review:
 * 1. Bundle inline comments into a structured prompt
 * 2. Create a new session (round N+1) with the original prompt + review feedback
 * 3. Start the session in a Docker sandbox
 * 4. Return the new session ID
 */
export async function rerunWithComments(reviewId: string): Promise<{
  sessionId: string;
  reviewRound: number;
} | null> {
  const db = getDb();

  // Get the review
  const review = db
    .select()
    .from(schema.reviews)
    .where(eq(schema.reviews.id, reviewId))
    .get();

  if (!review) return null;

  // Get the original session
  const originalSession = db
    .select()
    .from(schema.sessions)
    .where(eq(schema.sessions.id, review.sessionId))
    .get();

  if (!originalSession) return null;

  // Get the project
  const project = db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, originalSession.projectId))
    .get();

  if (!project) return null;

  // Get the agent definition
  const agent = db
    .select()
    .from(schema.agentDefinitions)
    .where(eq(schema.agentDefinitions.id, originalSession.agentDefinitionId))
    .get();

  if (!agent) return null;

  // Bundle comments into a prompt
  const commentPrompt = bundleCommentsAsPrompt(reviewId);

  // Build the combined prompt
  const combinedPrompt = [
    `This is review round ${review.round + 1}. The original task was:`,
    "",
    originalSession.prompt,
    "",
    "---",
    "",
    commentPrompt,
    "",
    "Please address all the review comments above. The codebase already contains the changes from the previous round.",
  ].join("\n");

  // Create a new session
  const now = new Date().toISOString();
  const newSessionId = uuid();
  db.insert(schema.sessions)
    .values({
      id: newSessionId,
      projectId: originalSession.projectId,
      subprojectId: originalSession.subprojectId,
      workflowRunId: originalSession.workflowRunId,
      stageName: originalSession.stageName,
      agentDefinitionId: originalSession.agentDefinitionId,
      credentialSetId: originalSession.credentialSetId,
      sandboxId: null,
      status: "pending",
      prompt: combinedPrompt,
      output: null,
      createdAt: now,
      completedAt: null,
    })
    .run();

  // Extract agent command from template
  const agentCommand = agent.commandTemplate.split(" ").slice(-1)[0] || "copilot";

  // Start the session
  startSession({
    sessionId: newSessionId,
    projectDir: project.localPath,
    agentCommand,
    credentialSetId: originalSession.credentialSetId,
    prompt: combinedPrompt,
  });

  return {
    sessionId: newSessionId,
    reviewRound: review.round + 1,
  };
}
