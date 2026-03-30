import { getDb, schema } from "@/lib/db";
import { launchAcpSession, getAcpSession, closeAcpSession, sendAcpPrompt, isAcpSession } from "./acp-client";
import type { AcpMessage, AcpLaunchOptions } from "./acp-client";
import { createWorktree, fastForwardMerge, commitAndMergeWorktree, removeWorktree, rebaseWorktree, commitWorktreeChanges } from "./worktree";
import { CopilotJsonlParser } from "./jsonl-parser";
import { eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { execSync } from "child_process";
import path from "path";
import fs from "fs";

const WORKTREE_DIR = ".vibe-harness-worktrees";

/** Callback for task state transitions — injected to avoid circular imports. */
type TransitionTaskFn = (taskId: string, event: { type: string; [key: string]: unknown }) => Promise<{ ok: boolean }>;

/** Module-level reference set by setTransitionTask(). Uses var to avoid TDZ
 *  issues when state-machine/index.ts calls setTransitionTask during its own
 *  module evaluation (circular import resolution). */
var _transitionTask: TransitionTaskFn | null = null;

/** Called by state-machine/index.ts at import time to wire the dependency. */
export function setTransitionTask(fn: TransitionTaskFn) {
  _transitionTask = fn;
}

export function getTransitionTask(): TransitionTaskFn {
  if (!_transitionTask) throw new Error("transitionTask not injected — call setTransitionTask() first");
  return _transitionTask;
}

export interface StartTaskOptions {
  taskId: string;
  projectDir: string;
  agentCommand: string;
  agentType?: string;
  credentialSetId?: string | null;
  dockerImage?: string | null;
  prompt: string;
  model?: string | null;
  useWorktree?: boolean;
  isContinuation?: boolean;
  originTaskId?: string | null;
  loadSessionId?: string | null; // Resume ACP session from previous stage
  mcpServers?: AcpLaunchOptions["mcpServers"]; // MCP servers for the agent session
  branch?: string | null;
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
        const wt = createWorktree(options.projectDir, options.taskId, undefined, options.branch || undefined);
        workDir = wt.worktreePath;
        branch = wt.branch;
        isWorktree = wt.isWorktree;
      } catch (e) {
        console.error("Failed to create worktree:", e);
        throw new Error(`Cannot create isolated worktree: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  // Always reuse the origin sandbox when part of a workflow chain.
  // Fresh sessions only reset the ACP agent session, not the Docker sandbox.
  const sandboxTaskId =
    options.originTaskId
      ? options.originTaskId
      : options.taskId;
  const shortId = sandboxTaskId.slice(0, 8);
  const sandboxName = `vibe-${shortId}`;

  // Mount the original project's .git dir so worktree git references resolve
  const extraWorkspaces: string[] = [];
  if (isWorktree) {
    const gitDir = path.join(options.projectDir, ".git");
    if (fs.existsSync(gitDir)) {
      extraWorkspaces.push(gitDir);
    }
  }

  // Launch ACP session — all tasks use ACP protocol for structured
  // communication and mid-execution intervention support
  const session = launchAcpSession(options.taskId, {
    projectDir: workDir,
    extraWorkspaces,
    agentCommand: options.agentCommand,
    credentialSetId: options.credentialSetId,
    dockerImage: options.dockerImage,
    model: options.model,
    isContinuation: options.isContinuation,
    sandboxName,
    loadSessionId: options.loadSessionId,
    mcpServers: options.mcpServers,
  });

  // Transition task: provisioning → running (sets sandboxId via action)
  getTransitionTask()(options.taskId, { type: "START", sandboxId: sandboxName });

  // When ACP session is ready, send the initial prompt
  session.events.on("ready", async () => {
    if (options.prompt) {
      await sendAcpPrompt(options.taskId, options.prompt);
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
  session.events.on("message", (msg: AcpMessage) => {
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

  // Listen for completion
  session.events.on("close", async (code: number) => {
    try {
      // Build output: conversation messages + always include stderr/raw output for diagnostics
      const conversationOutput = session.messages
        .map((m) => `[${m.role}] ${m.content}`)
        .join("\n\n");
      const stderrOutput = session.output.join("\n").trim();
      const outputParts = [
        conversationOutput,
        stderrOutput ? `\n--- stderr / raw ---\n${stderrOutput}` : "",
      ];
      const output = outputParts.filter(Boolean).join("\n") || `(no output captured, exit code: ${code})`;
      const lastMsg = session.messages.filter((m) => m.role === "assistant").pop();
      const lastAiMessage = lastMsg?.content || null;

      // Store ACP session ID on workflow run so next stage can load it
      const currentTask = db
        .select({
          workflowRunId: schema.tasks.workflowRunId,
          stageName: schema.tasks.stageName,
          projectId: schema.tasks.projectId,
        })
        .from(schema.tasks)
        .where(eq(schema.tasks.id, options.taskId))
        .get();

      if (currentTask?.workflowRunId && session.sessionId) {
        db.update(schema.workflowRuns)
          .set({ acpSessionId: session.sessionId })
          .where(eq(schema.workflowRuns.id, currentTask.workflowRunId))
          .run();
      }

      // Check if this was a manual pause — if so, just save output and stop
      const freshTask = db
        .select({ status: schema.tasks.status })
        .from(schema.tasks)
        .where(eq(schema.tasks.id, options.taskId))
        .get();
      if (freshTask?.status === "paused") {
        db.update(schema.tasks)
          .set({ output, lastAiMessage })
          .where(eq(schema.tasks.id, options.taskId))
          .run();
        return;
      }

      // Parse stderr for usage stats (Copilot CLI may output result event there)
      const jsonlParser = new CopilotJsonlParser();
      for (const raw of session.output) {
        for (const line of raw.split("\n")) {
          jsonlParser.parseLine(line);
        }
      }
      const parsedResult = jsonlParser.getResult();
      const usageStats = parsedResult.usage ? JSON.stringify(parsedResult.usage) : null;

      // Dispatch to state machine — all branching logic (split/autoAdvance/review,
      // workflow advancement, review creation) is handled by the machines.
      if (code === 0) {
        await getTransitionTask()(options.taskId, {
          type: "COMPLETE",
          output,
          lastAiMessage,
          exitCode: code,
          usageStats,
        });
      } else {
        await getTransitionTask()(options.taskId, {
          type: "FAIL",
          output,
          lastAiMessage,
          exitCode: code,
          usageStats,
        });
      }
      // Clean up Docker sandbox for non-workflow (standalone) tasks
      if (!currentTask?.workflowRunId) {
        try {
          execSync(`docker sandbox stop ${sandboxName}`, { stdio: "pipe" });
        } catch {
          // Best effort — sandbox may already be gone
        }
      }
    } catch (err) {
      console.error(`[task-manager] close handler error for task ${options.taskId}:`, err);
      try {
        await getTransitionTask()(options.taskId, {
          type: "FAIL",
          output: "Internal error during task completion",
          exitCode: code,
        });
      } catch {
        /* best-effort — already failing */
      }
    }
  });

  return session;
}

/** Stop a running task — pauses it for later resume */
export async function stopTask(taskId: string) {
  // Mark as paused BEFORE closing the session so the close handler
  // knows this was a manual stop (not a crash)
  await getTransitionTask()(taskId, { type: "PAUSE" });

  closeAcpSession(taskId);
  return true;
}

/** Send input to a running task via ACP */
export async function sendTaskInput(taskId: string, input: string) {
  const result = await sendAcpPrompt(taskId, input);
  return result.success;
}

/** Get ACP session for streaming */
export function getTaskAcpSession(taskId: string) {
  return getAcpSession(taskId);
}

/**
 * Finalize a task on the host: commit changes, rebase, merge, and clean up.
 */
export function finalizeAndMerge(
  originTaskId: string,
  opts?: { workflowRunId?: string | null; targetBranch?: string | null }
): { merged: boolean; branch: string; error?: string; mergeStrategy?: "fast-forward" | "no-ff" | "failed" } {
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

  // Use explicitly provided target, or task's stored targetBranch/branch, or detect from working tree
  let targetBranch = opts?.targetBranch || originTask.targetBranch || originTask.branch || null;
  if (!targetBranch) {
    try {
      targetBranch =
        execSync("git branch --show-current", {
          cwd: project.localPath,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        }).trim() || "main";
    } catch {
      targetBranch = "main";
    }
  }

  // Build commit message from task metadata
  const subject =
    originTask.title ||
    originTask.prompt.split("\n")[0].slice(0, 72) ||
    `vibe-harness: finalize task ${originTaskId.slice(0, 8)}`;
  const commitMessage = subject;

  // Check if the worktree exists — tasks with useWorktree:false won't have one
  const shortIdCheck = originTaskId.slice(0, 8);
  const worktreeCheckPath = path.join(project.localPath, WORKTREE_DIR, shortIdCheck);
  if (!fs.existsSync(worktreeCheckPath)) {
    return { merged: false, branch: "", error: "Task ran without worktree isolation — manual merge required" };
  }

  // 1. Commit any uncommitted changes in the worktree
  const commitResult = commitWorktreeChanges(
    project.localPath,
    originTaskId,
    commitMessage
  );
  if (commitResult.error) {
    console.warn("Commit step had an error:", commitResult.error);
  }

  // If nothing was committed and no error, check whether the branch has
  // any existing commits ahead of the target.  If not, there is nothing
  // to merge and we can bail early.
  if (!commitResult.committed && !commitResult.error) {
    const shortId = originTaskId.slice(0, 8);
    const worktreePath = path.join(project.localPath, WORKTREE_DIR, shortId);
    try {
      const ahead = execSync(`git rev-list --count ${targetBranch}..HEAD`, {
        cwd: worktreePath,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      if (ahead === "0") {
        return { merged: false, branch: `vibe-harness/task-${shortId}`, error: "No changes to merge" };
      }
    } catch {
      // Unable to determine — proceed with merge attempt
    }
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

  let mergeStrategy: "fast-forward" | "no-ff" | "failed" = "failed";

  if (rebaseResult.rebased) {
    // 3a. Rebase succeeded — try fast-forward merge
    const ffResult = fastForwardMerge(project.localPath, originTaskId, targetBranch);
    if (ffResult.merged) {
      merged = true;
      mergeStrategy = "fast-forward";
    } else {
      console.warn("FF merge failed after rebase, falling back to --no-ff:", ffResult.error);
    }
  }

  if (!merged) {
    // 3b. Fallback: --no-ff merge
    const fallback = commitAndMergeWorktree(
      project.localPath,
      originTaskId,
      commitMessage,
      targetBranch
    );
    merged = fallback.merged;
    if (merged) {
      mergeStrategy = "no-ff";
    } else {
      mergeError = fallback.error;
      console.error("Fallback merge also failed:", fallback.error);
    }
  }

  // 4. Clean up worktree and branch on success
  if (merged) {
    try {
      removeWorktree(project.localPath, originTaskId);
    } catch {
      // Non-critical
    }
    // Delete the task branch — no longer needed after merge
    try {
      execSync(`git branch -D "${branch}"`, {
        cwd: project.localPath,
        stdio: "pipe",
      });
    } catch {
      // Branch may already be deleted or not exist
    }
  }

  // Workflow run status is now handled by the state machine (FINALIZE event).
  // No direct DB update needed here.

  return { merged, branch, error: mergeError, mergeStrategy };
}
