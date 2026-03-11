import { getDb, schema } from "@/lib/db";
import { launchSandbox, stopSandbox, getSandbox, sendInput } from "./sandbox";
import { createWorktree } from "./worktree";
import { createReviewForTask } from "./review-service";
import { eq } from "drizzle-orm";
import path from "path";
import fs from "fs";

const WORKTREE_DIR = ".vibe-harness-worktrees";

export interface StartTaskOptions {
  taskId: string;
  projectDir: string;
  agentCommand: string;
  credentialSetId?: string | null;
  dockerImage?: string | null;
  prompt: string;
  model?: string | null;
  useWorktree?: boolean;
  isContinuation?: boolean;
  // When set, reuse the worktree from this task instead of creating a new one
  originTaskId?: string | null;
}

/** Start a task by launching its sandbox, optionally in a git worktree */
export function startTask(options: StartTaskOptions) {
  const db = getDb();
  const useWorktree = options.useWorktree !== false;

  let workDir = options.projectDir;
  let branch = "";
  let isWorktree = false;

  if (useWorktree) {
    // For continuation tasks, reuse the origin task's worktree
    if (options.originTaskId) {
      const originShortId = options.originTaskId.slice(0, 8);
      const existingWorktree = path.join(options.projectDir, WORKTREE_DIR, originShortId);
      if (fs.existsSync(existingWorktree)) {
        workDir = existingWorktree;
        isWorktree = true;
      }
    }

    // Only create a new worktree if we didn't find an existing one to reuse
    if (!isWorktree) {
      try {
        const wt = createWorktree(options.projectDir, options.taskId);
        workDir = wt.worktreePath;
        branch = wt.branch;
        isWorktree = wt.isWorktree;
      } catch (e) {
        console.error("Failed to create worktree, using project dir directly:", e);
      }
    }
  }

  // For continuations, reuse the origin sandbox name so Docker can --continue
  const sandboxTaskId = options.originTaskId || options.taskId;
  const shortId = sandboxTaskId.slice(0, 8);
  const sandboxName = `vibe-${shortId}`;

  const sandbox = launchSandbox(options.taskId, {
    projectDir: workDir,
    agentCommand: options.agentCommand,
    credentialSetId: options.credentialSetId,
    dockerImage: options.dockerImage,
    prompt: options.prompt,
    model: options.model,
    isContinuation: options.isContinuation,
    sandboxName,
  });

  // Update task status with worktree info
  db.update(schema.tasks)
    .set({
      status: "running",
      sandboxId: sandboxName,
    })
    .where(eq(schema.tasks.id, options.taskId))
    .run();

  // Listen for completion
  sandbox.events.on("close", async (code: number) => {
    const output = sandbox.output.join("");

    // Extract parsed JSONL output (available after close event)
    const parsedOutput = sandbox.parsedOutput ?? sandbox.jsonlParser.getResult();
    const lastAiMessage = parsedOutput.lastAiMessage || null;
    const usageStats = parsedOutput.usage
      ? JSON.stringify({
          premiumRequests: parsedOutput.usage.premiumRequests,
          totalApiDurationMs: parsedOutput.usage.totalApiDurationMs,
          sessionDurationMs: parsedOutput.usage.sessionDurationMs,
          codeChanges: parsedOutput.codeChanges,
        })
      : null;

    // Look up the task to find its workflow run (if any)
    const currentTask = db
      .select({ workflowRunId: schema.tasks.workflowRunId })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, options.taskId))
      .get();

    if (code === 0) {
      // Success: auto-create review and set awaiting_review
      db.update(schema.tasks)
        .set({
          status: "awaiting_review",
          output,
          lastAiMessage,
          usageStats,
          completedAt: new Date().toISOString(),
        })
        .where(eq(schema.tasks.id, options.taskId))
        .run();

      // Update workflow run status to awaiting_review
      if (currentTask?.workflowRunId) {
        db.update(schema.workflowRuns)
          .set({ status: "awaiting_review" })
          .where(eq(schema.workflowRuns.id, currentTask.workflowRunId))
          .run();
      }

      try {
        await createReviewForTask(options.taskId);
      } catch (e) {
        console.error("Failed to auto-create review:", e);
        db.update(schema.tasks)
          .set({ status: "completed" })
          .where(eq(schema.tasks.id, options.taskId))
          .run();
      }
    } else {
      db.update(schema.tasks)
        .set({
          status: "failed",
          output,
          lastAiMessage,
          usageStats,
          completedAt: new Date().toISOString(),
        })
        .where(eq(schema.tasks.id, options.taskId))
        .run();

      // Update workflow run status to failed
      if (currentTask?.workflowRunId) {
        db.update(schema.workflowRuns)
          .set({
            status: "failed",
            completedAt: new Date().toISOString(),
          })
          .where(eq(schema.workflowRuns.id, currentTask.workflowRunId))
          .run();
      }
    }
  });

  return sandbox;
}

/** Stop a running task */
export function stopTask(taskId: string) {
  const db = getDb();
  const stopped = stopSandbox(taskId);
  if (stopped) {
    db.update(schema.tasks)
      .set({
        status: "failed",
        completedAt: new Date().toISOString(),
      })
      .where(eq(schema.tasks.id, taskId))
      .run();
  }
  return stopped;
}

/** Send input to a running task */
export function sendTaskInput(taskId: string, input: string) {
  return sendInput(taskId, input);
}

/** Get sandbox for streaming */
export function getTaskSandbox(taskId: string) {
  return getSandbox(taskId);
}
