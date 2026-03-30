import { execSync } from "child_process";
import path from "path";
import fs from "fs";
import { getDb, schema } from "@/lib/db";
import { eq, or, and, inArray } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { parseUnifiedDiff, diffSummary } from "./diff-service";

const WORKTREE_DIR = ".vibe-harness-worktrees";

/**
 * Resolve the working directory for a task — worktree if it exists,
 * otherwise the project root.
 */
function resolveTaskWorkDir(projectDir: string, taskId: string): string {
  const shortId = taskId.slice(0, 8);
  const worktreePath = path.join(projectDir, WORKTREE_DIR, shortId);
  if (fs.existsSync(worktreePath)) {
    return worktreePath;
  }
  return projectDir;
}

/**
 * Capture the agent's plan.md from inside the Docker sandbox VM.
 * The Copilot CLI writes plans to ~/.copilot/session-state/<uuid>/plan.md
 * inside the sandbox. The sandbox VM persists after the agent exits
 * (which is how --continue works), so we can docker exec into it.
 */
function capturePlanFromSandbox(sandboxName: string): string | null {
  if (!sandboxName) return null;

  try {
    // Find plan.md files inside the sandbox
    const findResult = execSync(
      `docker sandbox exec ${sandboxName} find / -name "plan.md" -path "*session-state*" -type f 2>/dev/null || true`,
      { encoding: "utf-8", timeout: 10000 }
    ).trim();

    const files = findResult.split("\n").filter(Boolean);
    if (files.length === 0) return null;

    // Use the last one found (most recently created session)
    const planPath = files[files.length - 1];
    return execSync(
      `docker sandbox exec ${sandboxName} cat "${planPath}"`,
      { encoding: "utf-8", maxBuffer: 1024 * 1024, timeout: 10000 }
    );
  } catch (err) {
    // Sandbox may not support exec, or plan.md doesn't exist
    console.warn(
      `[capturePlanFromSandbox] Failed to capture plan from sandbox "${sandboxName}":`,
      err instanceof Error ? err.message : String(err)
    );
    return null;
  }
}

/**
 * Get the origin task ID for a task chain.
 * If the task has an originTaskId, return it. Otherwise, the task
 * itself is the origin.
 */
export function getOriginTaskId(taskId: string): string {
  const db = getDb();
  const task = db
    .select({ originTaskId: schema.tasks.originTaskId })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, taskId))
    .get();
  return task?.originTaskId || taskId;
}

/**
 * Get all task IDs in a chain (the origin + all reruns).
 */
export function getTaskChainIds(originTaskId: string): string[] {
  const db = getDb();
  const tasks = db
    .select({ id: schema.tasks.id })
    .from(schema.tasks)
    .where(
      or(
        eq(schema.tasks.id, originTaskId),
        eq(schema.tasks.originTaskId, originTaskId)
      )
    )
    .all();
  return tasks.map((s) => s.id);
}

/**
 * Count the total review rounds across a task chain.
 */
function countChainReviewRounds(taskId: string): number {
  const originId = getOriginTaskId(taskId);
  const chainIds = getTaskChainIds(originId);
  if (chainIds.length === 0) return 0;

  const db = getDb();
  const reviews = db
    .select()
    .from(schema.reviews)
    .where(inArray(schema.reviews.taskId, chainIds))
    .all();
  return reviews.length;
}

/**
 * Generate a diff for a task's worktree or committed changes.
 * Returns structured result with diffText, parsed files, diagnostics, and the workDir used.
 */
export async function generateTaskDiff(taskId: string): Promise<{
  diffText: string;
  files: ReturnType<typeof parseUnifiedDiff>;
  summary: string;
  workDir: string;
  method: string;
  diagnostics: string[];
  reviewUpdated?: boolean;
}> {
  const db = getDb();
  const diagnostics: string[] = [];

  const task = db
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.id, taskId))
    .get();

  if (!task) throw new Error(`Task ${taskId} not found`);

  const project = db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, task.projectId))
    .get();

  if (!project) throw new Error(`Project ${task.projectId} not found`);

  const originId = getOriginTaskId(taskId);
  const workDir = resolveTaskWorkDir(project.localPath, originId);
  diagnostics.push(`workDir: ${workDir}`);
  diagnostics.push(`originTaskId: ${originId}`);

  // Check if workDir exists
  if (!fs.existsSync(workDir)) {
    diagnostics.push(`ERROR: workDir does not exist`);
    return { diffText: "", files: [], summary: "0 files changed", workDir, method: "none", diagnostics };
  }

  // Check git status before staging
  try {
    const statusBefore = execSync("git status --porcelain", {
      cwd: workDir, encoding: "utf-8", maxBuffer: 1024 * 1024,
    });
    diagnostics.push(`git status before staging: ${statusBefore.trim().split("\n").length} files`);
    if (statusBefore.trim()) {
      diagnostics.push(`status sample: ${statusBefore.trim().split("\n").slice(0, 5).join(" | ")}`);
    }
  } catch (e) {
    diagnostics.push(`git status failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  let diffText = "";
  let method = "none";

  try {
    // Stage changes to tracked files (modified, deleted)
    execSync("git add -u", { cwd: workDir, stdio: "pipe" });
    diagnostics.push("git add -u: OK");

    // Stage new files too, but exclude bulk directories
    // Use :(exclude) long-form pathspec — short form ':!' fails on some git versions
    try {
      execSync(
        'git add -A --ignore-errors -- . ":(exclude)node_modules" ":(exclude).pnpm-store" ":(exclude).venv" ":(exclude)__pycache__"',
        { cwd: workDir, stdio: "pipe" },
      );
      diagnostics.push("git add -A (with exclusions): OK");
    } catch (e) {
      diagnostics.push(`git add -A failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Check status after staging
    try {
      const statusAfter = execSync("git diff --cached --stat HEAD", {
        cwd: workDir, encoding: "utf-8", maxBuffer: 1024 * 1024,
      });
      diagnostics.push(`staged diff stat: ${statusAfter.trim() || "(empty)"}`);
    } catch (e) {
      diagnostics.push(`diff --cached --stat failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Primary: diff staged changes against HEAD
    diffText = execSync("git diff --cached HEAD", {
      cwd: workDir,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
    });

    if (diffText.trim()) {
      method = "diff --cached HEAD";
      diagnostics.push(`diff --cached HEAD: ${diffText.length} bytes`);
    } else {
      diagnostics.push("diff --cached HEAD: empty");

      // Fallback: agent may have already committed — diff against merge-base
      try {
        let defaultBranch = "main";
        try {
          const ref = execSync("git symbolic-ref refs/remotes/origin/HEAD", {
            cwd: workDir, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
          }).trim();
          defaultBranch = ref.replace("refs/remotes/origin/", "");
        } catch { /* fall back to main */ }
        diagnostics.push(`defaultBranch: ${defaultBranch}`);

        const mergeBase = execSync(`git merge-base HEAD ${defaultBranch}`, {
          cwd: workDir, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
        }).trim();
        diagnostics.push(`mergeBase: ${mergeBase}`);

        const headSha = execSync("git rev-parse HEAD", {
          cwd: workDir, encoding: "utf-8",
        }).trim();
        diagnostics.push(`HEAD: ${headSha}`);

        if (mergeBase === headSha) {
          diagnostics.push("mergeBase === HEAD, no committed changes");
        }

        diffText = execSync(`git diff ${mergeBase} HEAD`, {
          cwd: workDir,
          encoding: "utf-8",
          maxBuffer: 10 * 1024 * 1024,
        });
        method = `diff ${mergeBase.slice(0, 8)} HEAD`;
        diagnostics.push(`merge-base diff: ${diffText.length} bytes`);
      } catch (e) {
        diagnostics.push(`merge-base failed: ${e instanceof Error ? e.message : String(e)}`);
        // Last resort: plain diff against HEAD
        diffText = execSync("git diff HEAD", {
          cwd: workDir, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024,
        });
        method = "diff HEAD";
        diagnostics.push(`diff HEAD: ${diffText.length} bytes`);
      }
    }
  } catch (e) {
    diagnostics.push(`primary diff path failed: ${e instanceof Error ? e.message : String(e)}`);
    try {
      diffText = execSync("git diff", {
        cwd: workDir,
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
      });
      method = "diff (unstaged)";
    } catch {
      diffText = "<!-- No git diff available -->";
      method = "error";
    }
  }

  const files = parseUnifiedDiff(diffText);
  const summary = diffSummary(files);

  return { diffText, files, summary, workDir, method, diagnostics };
}

/**
 * Create a review after an agent task completes.
 * Captures git diff from the worktree (includes uncommitted changes),
 * generates a summary, and stores as a Review record.
 */
export async function createReviewForTask(taskId: string): Promise<string | null> {
  const db = getDb();

  const task = db
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.id, taskId))
    .get();

  if (!task) return null;

  const project = db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, task.projectId))
    .get();

  if (!project) return null;

  let diffResult;
  try {
    diffResult = await generateTaskDiff(taskId);
    console.log(`[review-service] Diff generated for ${taskId}: method=${diffResult.method}, ${diffResult.files.length} files`);
    if (diffResult.diagnostics.length > 0) {
      console.log(`[review-service] Diagnostics:\n  ${diffResult.diagnostics.join("\n  ")}`);
    }
  } catch (e) {
    console.error(`[review-service] generateTaskDiff failed for ${taskId}:`, e);
    diffResult = { diffText: "", files: [] as ReturnType<typeof parseUnifiedDiff>, summary: "0 files changed" };
  }

  const { diffText, files } = diffResult;
  const isEmpty = diffText.trim() === "" || files.length === 0;

  if (isEmpty) {
    console.warn(
      `[review-service] Task ${taskId} completed with no changes (empty diff). Creating review for audit trail.`
    );
  }

  const summary = diffSummary(files);

  // Build AI summary (for now, use a structured summary; later, call an agent)
  const aiSummary = generateStructuredSummary(task, files, summary, isEmpty);

  // Try to capture agent's plan.md from the sandbox VM
  const planMarkdown = task.sandboxId ? capturePlanFromSandbox(task.sandboxId) : null;

  // Count existing reviews across the entire task chain to determine round
  const round = countChainReviewRounds(taskId) + 1;

  // Guard against duplicate review for the same task+round (concurrent creation)
  const existingReview = db.select({ id: schema.reviews.id })
    .from(schema.reviews)
    .where(and(
      eq(schema.reviews.taskId, taskId),
      eq(schema.reviews.round, round)
    ))
    .get();
  if (existingReview) {
    console.warn(`[createReviewForTask] Review already exists for task ${taskId} round ${round}`);
    return existingReview.id;
  }

  // Create review record
  const reviewId = uuid();
  const now = new Date().toISOString();
  db.insert(schema.reviews)
    .values({
      id: reviewId,
      workflowRunId: task.workflowRunId,
      taskId,
      round,
      status: "pending_review",
      aiSummary,
      diffSnapshot: diffText,
      planMarkdown: planMarkdown || null,
      createdAt: now,
    })
    .run();

  return reviewId;
}

/**
 * Regenerate a review's diffSnapshot and aiSummary from a fresh diff result.
 * Used by the /api/tasks/[id]/diff?update_review=true endpoint.
 */
export function regenerateReviewFromDiff(
  taskId: string,
  diffResult: { diffText: string; files: ReturnType<typeof parseUnifiedDiff>; summary: string },
): boolean {
  const db = getDb();

  const review = db
    .select()
    .from(schema.reviews)
    .where(eq(schema.reviews.taskId, taskId))
    .get();
  if (!review) return false;

  const task = db
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.id, taskId))
    .get();
  if (!task) return false;

  const isEmpty = diffResult.diffText.trim() === "" || diffResult.files.length === 0;
  const aiSummary = generateStructuredSummary(task, diffResult.files, diffResult.summary, isEmpty);

  db.update(schema.reviews)
    .set({ diffSnapshot: diffResult.diffText, aiSummary })
    .where(eq(schema.reviews.id, review.id))
    .run();

  return true;
}

function generateStructuredSummary(
  task: { prompt: string; output: string | null; lastAiMessage?: string | null },
  files: ReturnType<typeof parseUnifiedDiff>,
  changeSummary: string,
  isEmpty: boolean = false
): string {
  const totalAdded = files.reduce((s, f) => s + f.additions, 0);
  const totalDeleted = files.reduce((s, f) => s + f.deletions, 0);

  let md = `## Task Summary\n\n`;

  if (isEmpty) {
    md += `> ⚠️ **No changes detected.** The agent completed without modifying any files.\n\n`;
  }
  
  // Clean the prompt — strip markdown heading markers for inline display
  const cleanPrompt = (task.prompt ?? "")
    .replace(/^##\s+Task\s*/m, "")
    .replace(/^##\s+Current Stage:\s*/m, "**Current Stage:** ")
    .trim();
  md += `${cleanPrompt}\n\n`;

  // Include the agent's final AI message when available
  if (task.lastAiMessage) {
    md += `### Agent Summary\n\n`;
    md += `${task.lastAiMessage}\n\n`;
  }
  
  md += `### Changes Overview\n\n`;
  md += `**${files.length}** file(s) changed, **${totalAdded}** insertions(+), **${totalDeleted}** deletions(-)\n\n`;

  if (files.length > 0) {
    md += `| File | Status | Changes |\n`;
    md += `|------|--------|---------|\n`;
    for (const f of files) {
      const status = f.status === "added" ? "🟢 Added" : f.status === "deleted" ? "🔴 Deleted" : f.status === "renamed" ? "🔵 Renamed" : "🟡 Modified";
      md += `| \`${f.path}\` | ${status} | +${f.additions} -${f.deletions} |\n`;
    }
    md += `\n`;
  }

  return md;
}

/**
 * Bundle review comments into a structured prompt for the next agent round.
 */
export function bundleCommentsAsPrompt(reviewId: string): string {
  const db = getDb();

  const review = db
    .select()
    .from(schema.reviews)
    .where(eq(schema.reviews.id, reviewId))
    .get();

  if (!review) return "";

  const comments = db
    .select()
    .from(schema.reviewComments)
    .where(eq(schema.reviewComments.reviewId, reviewId))
    .all();

  if (comments.length === 0) return "";

  // Group comments by file, separating general comments
  const generalComments: typeof comments = [];
  const byFile = new Map<string, typeof comments>();
  for (const c of comments) {
    if (c.filePath === "__general__") {
      generalComments.push(c);
    } else {
      const existing = byFile.get(c.filePath) || [];
      existing.push(c);
      byFile.set(c.filePath, existing);
    }
  }

  let prompt = `The following review comments were left on your changes. Please address each one:\n\n`;

  if (generalComments.length > 0) {
    prompt += `## General Comments\n`;
    for (const c of generalComments) {
      prompt += `- ${JSON.stringify(c.body)}\n`;
    }
    prompt += `\n`;
  }

  for (const [filePath, fileComments] of byFile) {
    prompt += `## ${filePath}\n`;
    for (const c of fileComments) {
      const lineRef = c.lineNumber ? `Line ${c.lineNumber}: ` : "";
      prompt += `- ${lineRef}${JSON.stringify(c.body)}\n`;
    }
    prompt += `\n`;
  }

  return prompt;
}
