import { spawn } from "child_process";
import { EventEmitter } from "events";
import { getDb, schema } from "@/lib/db";
import { eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { bundleCommentsAsPrompt } from "./review-service";
import path from "path";
import fs from "fs";

const WORKTREE_DIR = ".vibe-harness-worktrees";

/**
 * Handle "request changes" on a review:
 * 1. Bundle inline comments into a structured prompt
 * 2. Run copilot --continue in the SAME sandbox with the feedback as prompt
 * 3. Create a new session record linked to the same worktree
 */
export async function rerunWithComments(reviewId: string): Promise<{
  sessionId: string;
  reviewRound: number;
} | null> {
  const db = getDb();

  const review = db
    .select()
    .from(schema.reviews)
    .where(eq(schema.reviews.id, reviewId))
    .get();
  if (!review) return null;

  const originalSession = db
    .select()
    .from(schema.sessions)
    .where(eq(schema.sessions.id, review.sessionId))
    .get();
  if (!originalSession) return null;

  const project = db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, originalSession.projectId))
    .get();
  if (!project) return null;

  const agent = db
    .select()
    .from(schema.agentDefinitions)
    .where(eq(schema.agentDefinitions.id, originalSession.agentDefinitionId))
    .get();
  if (!agent) return null;

  // Bundle comments into a prompt
  const commentPrompt = bundleCommentsAsPrompt(reviewId);
  const combinedPrompt = [
    "Please address these review comments on your previous changes:",
    "",
    commentPrompt,
  ].join("\n");

  // Resolve the SAME worktree that the original session used
  const originalShortId = originalSession.id.slice(0, 8);
  const worktreePath = path.join(project.localPath, WORKTREE_DIR, originalShortId);
  const workDir = fs.existsSync(worktreePath) ? worktreePath : project.localPath;

  // Reuse the original sandbox name
  const sandboxName = originalSession.sandboxId || `vibe-${originalShortId}`;

  // Create a new session record (for tracking), linked to same worktree
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
      sandboxId: sandboxName,
      status: "running",
      prompt: combinedPrompt,
      model: originalSession.model,
      useWorktree: originalSession.useWorktree,
      output: null,
      createdAt: now,
      completedAt: null,
    })
    .run();

  // Run copilot --continue in the same sandbox
  // docker sandbox run <sandbox-name> -- --yolo --continue -p "review comments"
  const args = ["sandbox", "run", sandboxName, "--", "--yolo", "--continue", "-p", combinedPrompt];

  if (originalSession.model) {
    args.push("--model", originalSession.model);
  }

  const env = { ...process.env };
  // Inject GH token
  if (!env.GITHUB_TOKEN && !env.GH_TOKEN) {
    try {
      const token = require("child_process")
        .execSync("gh auth token", { encoding: "utf-8" })
        .trim();
      if (token) env.GITHUB_TOKEN = token;
    } catch {}
  }

  const proc = spawn("docker", args, {
    env,
    cwd: workDir,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const output: string[] = [];

  proc.stdout?.on("data", (data: Buffer) => {
    output.push(data.toString());
  });

  proc.stderr?.on("data", (data: Buffer) => {
    output.push(data.toString());
  });

  proc.on("close", (code) => {
    const status = code === 0 ? "completed" : "failed";
    db.update(schema.sessions)
      .set({
        status,
        output: output.join(""),
        completedAt: new Date().toISOString(),
      })
      .where(eq(schema.sessions.id, newSessionId))
      .run();
  });

  return {
    sessionId: newSessionId,
    reviewRound: review.round + 1,
  };
}
