import { getDb, schema } from "@/lib/db";
import { launchSandbox, stopSandbox, getSandbox, sendInput } from "./sandbox";
import { launchAcpSession, getAcpSession, closeAcpSession, sendAcpPrompt, cancelAcpOperation, isAcpSession } from "./acp-client";
import { createWorktree, fastForwardMerge, commitAndMergeWorktree, removeWorktree, rebaseWorktree, commitWorktreeChanges } from "./worktree";
import { createReviewForTask } from "./review-service";
import { advanceWorkflow, getStageConfig } from "../services/workflow-engine";
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
  agentType?: string; // copilot_cli | copilot_cli_acp
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

  // For continuations, reuse the origin sandbox name so Docker can --continue.
  // For fresh sessions (isContinuation=false with originTaskId), use a new
  // sandbox name so the agent starts with a clean session.
  const sandboxTaskId =
    options.isContinuation && options.originTaskId
      ? options.originTaskId
      : options.taskId;
  const shortId = sandboxTaskId.slice(0, 8);
  const sandboxName = `vibe-${shortId}`;

  // Branch based on agent type: ACP mode vs legacy JSONL mode
  const isAcpMode = options.agentType === "copilot_cli_acp";

  if (isAcpMode) {
    return startTaskAcp(options, workDir, sandboxName);
  }

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
      // Legacy finalize tasks are no longer created, but handle gracefully
      // if one is somehow still in flight.
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
      return;
    }

    if (code === 0) {
      // Check stage config for autoAdvance / reviewRequired
      const stageConfig =
        currentTask?.workflowRunId && currentTask?.stageName
          ? getStageConfig(currentTask.workflowRunId, currentTask.stageName)
          : null;
      const shouldAutoAdvance = stageConfig?.autoAdvance === true;

      if (shouldAutoAdvance) {
        // Auto-advance: skip review, mark completed, advance workflow
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

        if (currentTask?.workflowRunId) {
          try {
            const result = await advanceWorkflow(currentTask.workflowRunId);
            // If workflow completed, finalize on the host (commit, rebase, merge)
            if (result?.completed) {
              const originId = options.originTaskId || options.taskId;
              try {
                finalizeAndMerge(originId, {
                  workflowRunId: currentTask.workflowRunId,
                });
              } catch (e) {
                console.error("Failed to finalize after auto-advance:", e);
              }
            }
          } catch (e) {
            console.error("Failed to auto-advance workflow:", e);
          }
        }
      } else {
        // Review required (default): create review and wait for approval
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

/** Start a task using ACP protocol for structured communication */
function startTaskAcp(
  options: StartTaskOptions,
  workDir: string,
  sandboxName: string
) {
  const db = getDb();

  const session = launchAcpSession(options.taskId, {
    projectDir: workDir,
    agentCommand: options.agentCommand,
    credentialSetId: options.credentialSetId,
    dockerImage: options.dockerImage,
    model: options.model,
    isContinuation: options.isContinuation,
    sandboxName,
  });

  // Update task status
  db.update(schema.tasks)
    .set({
      status: "running",
      sandboxId: sandboxName,
      executionMode: "acp",
    })
    .where(eq(schema.tasks.id, options.taskId))
    .run();

  // When ACP session is ready, send the initial prompt
  session.events.on("ready", async () => {
    if (options.prompt) {
      await sendAcpPrompt(options.taskId, options.prompt);

      // Store the initial prompt as a task message
      db.insert(schema.taskMessages)
        .values({
          id: crypto.randomUUID(),
          taskId: options.taskId,
          role: "user",
          content: options.prompt,
          isIntervention: 0,
          createdAt: new Date().toISOString(),
        })
        .run();
    }
  });

  // Store assistant messages
  session.events.on("message", (msg: { role: string; content: string; metadata?: { isIntervention?: boolean } }) => {
    if (msg.role === "assistant" && msg.content) {
      db.insert(schema.taskMessages)
        .values({
          id: crypto.randomUUID(),
          taskId: options.taskId,
          role: "assistant",
          content: msg.content,
          isIntervention: 0,
          createdAt: new Date().toISOString(),
        })
        .run();
    }
  });

  // Listen for completion (same as legacy path)
  session.events.on("close", async (code: number) => {
    const output = session.output.join("\n");
    const lastMsg = session.messages
      .filter((m) => m.role === "assistant")
      .pop();
    const lastAiMessage = lastMsg?.content || null;

    const currentTask = db
      .select({
        workflowRunId: schema.tasks.workflowRunId,
        stageName: schema.tasks.stageName,
        projectId: schema.tasks.projectId,
      })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, options.taskId))
      .get();

    if (code === 0) {
      const stageConfig =
        currentTask?.workflowRunId && currentTask?.stageName
          ? getStageConfig(currentTask.workflowRunId, currentTask.stageName)
          : null;
      const shouldAutoAdvance = stageConfig?.autoAdvance === true;

      if (shouldAutoAdvance) {
        db.update(schema.tasks)
          .set({
            status: "completed",
            output,
            lastAiMessage,
            completedAt: new Date().toISOString(),
          })
          .where(eq(schema.tasks.id, options.taskId))
          .run();

        if (currentTask?.workflowRunId) {
          try {
            const result = await advanceWorkflow(currentTask.workflowRunId);
            if (result?.completed) {
              const originId = options.originTaskId || options.taskId;
              try {
                finalizeAndMerge(originId, {
                  workflowRunId: currentTask.workflowRunId,
                });
              } catch (e) {
                console.error("Failed to finalize after auto-advance:", e);
              }
            }
          } catch (e) {
            console.error("Failed to auto-advance workflow:", e);
          }
        }
      } else {
        db.update(schema.tasks)
          .set({
            status: "awaiting_review",
            output,
            lastAiMessage,
            completedAt: new Date().toISOString(),
          })
          .where(eq(schema.tasks.id, options.taskId))
          .run();

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
      }
    } else {
      db.update(schema.tasks)
        .set({
          status: "failed",
          output,
          lastAiMessage,
          completedAt: new Date().toISOString(),
        })
        .where(eq(schema.tasks.id, options.taskId))
        .run();

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

  return session;
}

/** Stop a running task */
export function stopTask(taskId: string) {
  const db = getDb();

  // Try ACP session first, then legacy sandbox
  let stopped = false;
  if (isAcpSession(taskId)) {
    stopped = closeAcpSession(taskId);
  } else {
    stopped = stopSandbox(taskId);
  }

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
  // For ACP sessions, use the structured prompt
  if (isAcpSession(taskId)) {
    sendAcpPrompt(taskId, input);
    return true;
  }
  return sendInput(taskId, input);
}

/** Get sandbox for streaming (legacy mode) */
export function getTaskSandbox(taskId: string) {
  return getSandbox(taskId);
}

/** Get ACP session for streaming (ACP mode) */
export function getTaskAcpSession(taskId: string) {
  return getAcpSession(taskId);
}

/**
 * Finalize a task on the host: commit changes, rebase, merge, and clean up.
 * Replaces the old agent-based finalize which failed inside Docker because
 * the worktree's .git file references a host path not mounted in the container.
 */
export function finalizeAndMerge(
  originTaskId: string,
  opts?: { workflowRunId?: string | null }
): { merged: boolean; branch: string; error?: string } {
  const db = getDb();

  const originTask = db
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.id, originTaskId))
    .get();
  if (!originTask) return { merged: false, branch: "", error: "Origin task not found" };

  const project = db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, originTask.projectId))
    .get();
  if (!project) return { merged: false, branch: "", error: "Project not found" };

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

  // Build commit message from task metadata
  const subject =
    originTask.title ||
    originTask.prompt.split("\n")[0].slice(0, 72) ||
    `vibe-harness: finalize task ${originTaskId.slice(0, 8)}`;
  const commitMessage = subject;

  // 1. Commit any uncommitted changes in the worktree
  const commitResult = commitWorktreeChanges(
    project.localPath,
    originTaskId,
    commitMessage
  );
  if (commitResult.error) {
    console.warn("Commit step had an error:", commitResult.error);
  }

  // 2. Try to rebase onto target branch
  const rebaseResult = rebaseWorktree(
    project.localPath,
    originTaskId,
    targetBranch
  );

  let merged = false;
  let mergeError: string | undefined;
  const shortId = originTaskId.slice(0, 8);
  const branch = `vibe-harness/task-${shortId}`;

  if (rebaseResult.rebased) {
    // 3a. Rebase succeeded — try fast-forward merge
    const ffResult = fastForwardMerge(project.localPath, originTaskId);
    if (ffResult.merged) {
      merged = true;
    } else {
      console.warn("FF merge failed after rebase, falling back to --no-ff:", ffResult.error);
    }
  }

  if (!merged) {
    // 3b. Fallback: --no-ff merge
    const fallback = commitAndMergeWorktree(
      project.localPath,
      originTaskId,
      commitMessage
    );
    merged = fallback.merged;
    if (!merged) {
      mergeError = fallback.error;
      console.error("Fallback merge also failed:", fallback.error);
    }
  }

  // 4. Clean up worktree on success
  if (merged) {
    try {
      removeWorktree(project.localPath, originTaskId);
    } catch {
      // Non-critical
    }
  }

  // 5. Update workflow status if applicable
  const workflowRunId = opts?.workflowRunId || originTask.workflowRunId;
  if (workflowRunId) {
    db.update(schema.workflowRuns)
      .set({
        status: "completed",
        completedAt: new Date().toISOString(),
      })
      .where(eq(schema.workflowRuns.id, workflowRunId))
      .run();
  }

  return { merged, branch, error: mergeError };
}
