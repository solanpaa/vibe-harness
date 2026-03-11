import { getDb, schema } from "@/lib/db";
import { launchSandbox, stopSandbox, getSandbox, sendInput } from "./sandbox";
import { createWorktree, fastForwardMerge, commitAndMergeWorktree, removeWorktree } from "./worktree";
import { createReviewForTask } from "./review-service";
import { eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { execSync } from "child_process";
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

    const currentTask = db
      .select({
        workflowRunId: schema.tasks.workflowRunId,
        stageName: schema.tasks.stageName,
        projectId: schema.tasks.projectId,
      })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, options.taskId))
      .get();

    const isFinalize = currentTask?.stageName === "finalize";

    if (isFinalize) {
      // Finalize task — merge and cleanup, no review needed
      db.update(schema.tasks)
        .set({
          status: "completed",
          output,
          lastAiMessage,
          usageStats,
          completedAt: new Date().toISOString(),
        })
        .where(eq(schema.tasks.id, options.taskId))
        .run();

      const originId = options.originTaskId || options.taskId;
      await completeFinalizeTask(originId, currentTask!, code !== 0);
      return;
    }

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

/**
 * Complete a finalize task: fast-forward merge the task branch into the
 * main working tree, clean up the worktree, and mark the workflow done.
 * Falls back to mechanical --no-ff merge if ff fails.
 */
async function completeFinalizeTask(
  originId: string,
  task: { workflowRunId: string | null; projectId: string },
  aiFailed: boolean
) {
  const db = getDb();
  const project = db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, task.projectId))
    .get();

  if (!project) {
    console.error("Finalize: project not found for", task.projectId);
    return;
  }

  let merged = false;

  if (!aiFailed) {
    // AI succeeded — try fast-forward (branch should be rebased)
    const ffResult = fastForwardMerge(project.localPath, originId);
    if (ffResult.merged) {
      merged = true;
    } else {
      console.warn("FF merge failed, falling back to --no-ff:", ffResult.error);
    }
  }

  if (!merged) {
    // Fallback: mechanical commit + --no-ff merge
    const fallback = commitAndMergeWorktree(
      project.localPath,
      originId,
      "vibe-harness: finalize"
    );
    merged = fallback.merged;
    if (!merged) {
      console.error("Fallback merge also failed:", fallback.error);
    }
  }

  if (merged) {
    try {
      removeWorktree(project.localPath, originId);
    } catch {
      // Non-critical
    }
  }

  if (task.workflowRunId) {
    db.update(schema.workflowRuns)
      .set({
        status: "completed",
        completedAt: new Date().toISOString(),
      })
      .where(eq(schema.workflowRuns.id, task.workflowRunId))
      .run();
  }
}

/**
 * Launch a finalize task that prompts the AI to commit with a clean message
 * and rebase onto the target branch. The completion handler will then
 * fast-forward merge and clean up.
 */
export function startFinalizeTask(
  originTaskId: string,
  opts?: { workflowRunId?: string | null }
): { taskId: string } {
  const db = getDb();

  const originTask = db
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.id, originTaskId))
    .get();
  if (!originTask) throw new Error("Origin task not found");

  const project = db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, originTask.projectId))
    .get();
  if (!project) throw new Error("Project not found");

  const agent = db
    .select()
    .from(schema.agentDefinitions)
    .where(eq(schema.agentDefinitions.id, originTask.agentDefinitionId))
    .get();
  if (!agent) throw new Error("Agent not found");

  // Detect target branch from main working tree
  let targetBranch = "main";
  try {
    targetBranch =
      execSync("git branch --show-current", {
        cwd: project.localPath,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim() || "main";
  } catch {
    // default to "main"
  }

  const prompt = [
    "Commit all your changes with a clean, descriptive commit message that summarizes the work you have done.",
    `Then rebase your branch onto \`${targetBranch}\` and resolve any conflicts if needed.`,
    "Do not push or create a PR — just commit and rebase.",
  ].join(" ");

  const taskId = uuid();
  const now = new Date().toISOString();

  db.insert(schema.tasks)
    .values({
      id: taskId,
      projectId: originTask.projectId,
      workflowRunId: opts?.workflowRunId || originTask.workflowRunId,
      stageName: "finalize",
      agentDefinitionId: originTask.agentDefinitionId,
      credentialSetId: originTask.credentialSetId,
      sandboxId: null,
      originTaskId,
      status: "pending",
      prompt,
      title: "Finalize: commit & rebase",
      model: originTask.model,
      useWorktree: originTask.useWorktree,
      output: null,
      createdAt: now,
      completedAt: null,
    })
    .run();

  const agentCommand = agent.commandTemplate || "copilot";

  startTask({
    taskId,
    projectDir: project.localPath,
    agentCommand,
    credentialSetId: originTask.credentialSetId,
    prompt,
    model: originTask.model,
    useWorktree: originTask.useWorktree === 1,
    isContinuation: true,
    originTaskId,
  });

  return { taskId };
}
