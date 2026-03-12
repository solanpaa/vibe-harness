import { getDb, schema } from "@/lib/db";
import { eq, desc, and } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { execSync } from "child_process";
import path from "path";
import fs from "fs";

const WORKTREE_DIR = ".vibe-harness-worktrees";

/**
 * Create a task proposal from the split agent's MCP tool call.
 */
export function createProposal(input: {
  taskId: string;
  title: string;
  description: string;
  affectedFiles?: string[];
  dependsOn?: string[];
}) {
  const db = getDb();
  const now = new Date().toISOString();

  // Get current max sortOrder for this task
  const existing = db
    .select()
    .from(schema.taskProposals)
    .where(eq(schema.taskProposals.taskId, input.taskId))
    .all();

  const maxOrder = existing.reduce(
    (max, p) => Math.max(max, p.sortOrder),
    -1
  );

  const proposal = {
    id: uuid(),
    taskId: input.taskId,
    parallelGroupId: null,
    title: input.title,
    description: input.description,
    affectedFiles: input.affectedFiles
      ? JSON.stringify(input.affectedFiles)
      : null,
    dependsOn: input.dependsOn ? JSON.stringify(input.dependsOn) : null,
    status: "proposed" as const,
    launchedWorkflowRunId: null,
    sortOrder: maxOrder + 1,
    createdAt: now,
    updatedAt: now,
  };

  db.insert(schema.taskProposals).values(proposal).run();

  return {
    ...proposal,
    affectedFiles: input.affectedFiles || [],
    dependsOn: input.dependsOn || [],
  };
}

/**
 * List all proposals for a given task.
 */
export function listProposals(taskId: string) {
  const db = getDb();
  const rows = db
    .select()
    .from(schema.taskProposals)
    .where(eq(schema.taskProposals.taskId, taskId))
    .orderBy(schema.taskProposals.sortOrder)
    .all();

  return rows.map((r) => ({
    ...r,
    affectedFiles: r.affectedFiles ? JSON.parse(r.affectedFiles) : [],
    dependsOn: r.dependsOn ? JSON.parse(r.dependsOn) : [],
  }));
}

/**
 * Delete a proposal by ID.
 */
export function deleteProposal(proposalId: string): boolean {
  const db = getDb();
  const result = db
    .delete(schema.taskProposals)
    .where(eq(schema.taskProposals.id, proposalId))
    .run();
  return result.changes > 0;
}

/**
 * Update a proposal (for user edits in the review UI).
 */
export function updateProposal(
  proposalId: string,
  updates: {
    title?: string;
    description?: string;
    affectedFiles?: string[];
    dependsOn?: string[];
    status?: string;
    sortOrder?: number;
  }
) {
  const db = getDb();
  const now = new Date().toISOString();

  const setValues: Record<string, unknown> = { updatedAt: now };
  if (updates.title !== undefined) setValues.title = updates.title;
  if (updates.description !== undefined)
    setValues.description = updates.description;
  if (updates.affectedFiles !== undefined)
    setValues.affectedFiles = JSON.stringify(updates.affectedFiles);
  if (updates.dependsOn !== undefined)
    setValues.dependsOn = JSON.stringify(updates.dependsOn);
  if (updates.status !== undefined) setValues.status = updates.status;
  if (updates.sortOrder !== undefined) setValues.sortOrder = updates.sortOrder;

  db.update(schema.taskProposals)
    .set(setValues)
    .where(eq(schema.taskProposals.id, proposalId))
    .run();

  return db
    .select()
    .from(schema.taskProposals)
    .where(eq(schema.taskProposals.id, proposalId))
    .get();
}

/**
 * Retrieve the approved plan from the previous stage's review.
 * Looks up the workflow run for this task, finds the most recent review
 * with planMarkdown, and returns it.
 */
export function getPlan(taskId: string): string | null {
  const db = getDb();

  // Get the task to find its workflow run
  const task = db
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.id, taskId))
    .get();

  if (!task?.workflowRunId) return null;

  // Find the most recent review for this workflow run that has a plan
  const review = db
    .select()
    .from(schema.reviews)
    .where(eq(schema.reviews.workflowRunId, task.workflowRunId))
    .orderBy(desc(schema.reviews.createdAt))
    .limit(1)
    .get();

  if (!review) return null;

  // Also get the task that produced the review for its lastAiMessage fallback
  const reviewTask = db
    .select({ lastAiMessage: schema.tasks.lastAiMessage })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, review.taskId))
    .get();

  return (
    review.planMarkdown ||
    review.aiSummary ||
    reviewTask?.lastAiMessage ||
    null
  );
}

/**
 * Get the project file tree for a task's project, respecting .gitignore.
 * Uses `git ls-files` for tracked files + `git ls-files --others --exclude-standard`
 * for untracked but not ignored files.
 */
export function getProjectTree(
  taskId: string,
  options?: { maxDepth?: number; directory?: string }
): string | null {
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

  if (!project?.localPath) return null;

  // Resolve working directory (worktree if available)
  const shortId = taskId.slice(0, 8);
  const worktreePath = path.join(
    project.localPath,
    WORKTREE_DIR,
    shortId
  );
  const workDir = fs.existsSync(worktreePath)
    ? worktreePath
    : project.localPath;

  const targetDir = options?.directory
    ? path.join(workDir, options.directory)
    : workDir;

  try {
    // Use git ls-files for a clean, .gitignore-respecting listing
    const tracked = execSync(
      `git ls-files --cached --others --exclude-standard`,
      { cwd: targetDir, encoding: "utf-8", maxBuffer: 5 * 1024 * 1024 }
    ).trim();

    let files = tracked.split("\n").filter(Boolean);

    // Apply max depth filter
    if (options?.maxDepth) {
      files = files.filter(
        (f) => f.split("/").length <= options.maxDepth!
      );
    }

    // Build a tree representation
    return files.sort().join("\n");
  } catch (e) {
    return `Error listing files: ${(e as Error).message}`;
  }
}
