import { execSync } from "child_process";
import path from "path";
import fs from "fs";
import { getDb, schema } from "@/lib/db";
import { eq, or, inArray } from "drizzle-orm";
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
  } catch {
    // Sandbox may not support exec, or plan.md doesn't exist
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

  const workDir = resolveTaskWorkDir(project.localPath, getOriginTaskId(taskId));

  // Capture ALL changes: staged, unstaged, and untracked new files
  let diffText = "";
  try {
    // First, add untracked files to the index so they show up in the diff
    execSync("git add -N .", { cwd: workDir, stdio: "pipe" });
    // Then diff everything against HEAD
    diffText = execSync("git diff HEAD", {
      cwd: workDir,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch {
    try {
      // Fallback: just diff working tree
      diffText = execSync("git diff", {
        cwd: workDir,
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch {
      diffText = "<!-- No git diff available -->";
    }
  }

  // Parse and generate summary
  const files = parseUnifiedDiff(diffText);
  const summary = diffSummary(files);

  // Build AI summary (for now, use a structured summary; later, call an agent)
  const aiSummary = generateStructuredSummary(task, files, summary);

  // Try to capture agent's plan.md from the sandbox VM
  const planMarkdown = task.sandboxId ? capturePlanFromSandbox(task.sandboxId) : null;

  // Count existing reviews across the entire task chain to determine round
  const round = countChainReviewRounds(taskId) + 1;

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

function generateStructuredSummary(
  task: { prompt: string; output: string | null; lastAiMessage?: string | null },
  files: ReturnType<typeof parseUnifiedDiff>,
  changeSummary: string
): string {
  const totalAdded = files.reduce((s, f) => s + f.additions, 0);
  const totalDeleted = files.reduce((s, f) => s + f.deletions, 0);

  let md = `## Task Summary\n\n`;
  
  // Clean the prompt — strip markdown heading markers for inline display
  const cleanPrompt = task.prompt
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
