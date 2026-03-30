import { getDb, schema } from "@/lib/db";
import { eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { execSync, spawnSync } from "child_process";
import path from "path";
import fs from "fs";
import { listProposals } from "./proposal-service";
import { startWorkflowRun } from "./workflow-engine";

const MAX_CONCURRENT = 10;
const WORKTREE_DIR = ".vibe-harness-worktrees";

/**
 * Build the prompt for a sub-task from its proposal.
 * Focused only on the specific assignment — no full plan dump.
 */
function buildSubTaskPrompt(
  proposal: { title: string; description: string; affectedFiles: string[] },
): string {
  const parts: string[] = [];

  parts.push(`## Your Assignment: ${proposal.title}\n\n${proposal.description}`);

  if (proposal.affectedFiles.length > 0) {
    parts.push(
      `## Files to Modify\n${proposal.affectedFiles.map((f) => `- ${f}`).join("\n")}`
    );
  }

  parts.push(
    `## Guidelines\n` +
    `- Focus exclusively on the task described above.\n` +
    `- Do not modify files outside the scope of this assignment unless strictly necessary.\n` +
    `- Match the project's existing code style and conventions.`
  );

  return parts.join("\n\n");
}

/**
 * Launch proposals as parallel workflow runs.
 * Creates a parallel group and kicks off independent workflow runs.
 */
export async function launchProposals(input: {
  taskId: string;
  proposalIds?: string[];
  workflowTemplateId?: string;
  useFullWorkflow?: boolean;
}): Promise<{
  parallelGroupId: string;
  workflowRunIds: string[];
  launched: number;
  queued: number;
}> {
  const db = getDb();

  // Get the split task
  const splitTask = db
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.id, input.taskId))
    .get();

  if (!splitTask) throw new Error("Task not found");

  // Get proposals
  const allProposals = listProposals(input.taskId);
  const proposals = input.proposalIds
    ? allProposals.filter((p) => input.proposalIds!.includes(p.id))
    : allProposals.filter((p) => p.status !== "discarded");

  if (proposals.length === 0) {
    throw new Error("No proposals to launch");
  }

  // Get or create the sub-task template
  const DIRECT_EXECUTE_ID = "00000000-0000-0000-0000-000000000012";
  const FULL_WORKFLOW_ID = "00000000-0000-0000-0000-000000000010";
  let templateId = input.workflowTemplateId;
  if (!templateId) {
    templateId = input.useFullWorkflow ? FULL_WORKFLOW_ID : DIRECT_EXECUTE_ID;
  }

  // Create parallel group
  const now = new Date().toISOString();
  const groupId = uuid();
  db.insert(schema.parallelGroups)
    .values({
      id: groupId,
      sourceWorkflowRunId: splitTask.workflowRunId || splitTask.id,
      name: `Parallel: ${splitTask.prompt.slice(0, 60)}`,
      description: `${proposals.length} sub-tasks from split stage`,
      status: "running",
      createdAt: now,
    })
    .run();

  // Build dependency graph to determine launch order
  const proposalMap = new Map(proposals.map((p) => [p.title, p]));

  // Sort: independent proposals first, then dependent ones
  // (dependencies reference other proposals by title — if the dep isn't in
  //  this batch, launch anyway since it won't be satisfied)
  const independent: typeof proposals = [];
  const dependent: typeof proposals = [];

  for (const p of proposals) {
    const hasDeps =
      p.dependsOn.length > 0 &&
      p.dependsOn.some((dep: string) => proposalMap.has(dep));
    if (hasDeps) {
      dependent.push(p);
    } else {
      independent.push(p);
    }
  }

  // Launch all proposals — independent first, then dependent
  if (dependent.length > 0) {
    console.warn(
      `[parallel-launcher] ${dependent.length} proposal(s) have dependencies but will be launched in parallel. Dependencies are not currently enforced at runtime.`
    );
  }
  const allToLaunch = [...independent, ...dependent];

  // Get the agent definition from the split task
  const agentId = splitTask.agentDefinitionId;

  const workflowRunIds: string[] = [];

  for (const proposal of allToLaunch) {
    const prompt = buildSubTaskPrompt(proposal);

    try {
      const result = await startWorkflowRun({
        workflowTemplateId: templateId,
        projectId: splitTask.projectId,
        taskDescription: prompt,
        agentDefinitionId: agentId,
        credentialSetId: splitTask.credentialSetId,
        model: splitTask.model,
        useWorktree: true,
        branch: splitTask.branch,
      });

      workflowRunIds.push(result.runId);

      // Link the workflow run to the parallel group and proposal
      db.update(schema.workflowRuns)
        .set({
          parallelGroupId: groupId,
          sourceProposalId: proposal.id,
        })
        .where(eq(schema.workflowRuns.id, result.runId))
        .run();

      // Update proposal status
      db.update(schema.taskProposals)
        .set({
          status: "launched",
          parallelGroupId: groupId,
          launchedWorkflowRunId: result.runId,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(schema.taskProposals.id, proposal.id))
        .run();
    } catch (e) {
      console.error(`Failed to launch proposal "${proposal.title}":`, e);
    }
  }

  // The parent workflow run's status transition to "running_parallel" is handled
  // by the state machine (LAUNCH_PROPOSALS event). No direct DB update needed here.

  return {
    parallelGroupId: groupId,
    workflowRunIds,
    launched: workflowRunIds.length,
    queued: 0,
  };
}

/**
 * Get aggregated status for a parallel group.
 */
export function getParallelGroupStatus(groupId: string) {
  const db = getDb();

  const group = db
    .select()
    .from(schema.parallelGroups)
    .where(eq(schema.parallelGroups.id, groupId))
    .get();

  if (!group) return null;

  const childRuns = db
    .select({ status: schema.workflowRuns.status })
    .from(schema.workflowRuns)
    .where(eq(schema.workflowRuns.parallelGroupId, groupId))
    .all();

  const total = childRuns.length;
  const completed = childRuns.filter((r) => r.status === "completed").length;
  const failed = childRuns.filter((r) => r.status === "failed").length;

  return {
    ...group,
    total,
    completed,
    failed,
    allDone: total > 0 && completed + failed === total,
    allSucceeded: total > 0 && completed === total,
  };
}

/**
 * Consolidate all completed child run branches into a single consolidation branch.
 * Merges branches sequentially; stops on first conflict.
 */
export function consolidateParallelGroup(groupId: string): {
  success: boolean;
  branch: string;
  mergedCount: number;
  error?: string;
} {
  const db = getDb();

  const group = db
    .select()
    .from(schema.parallelGroups)
    .where(eq(schema.parallelGroups.id, groupId))
    .get();

  if (!group) {
    return { success: false, branch: "", mergedCount: 0, error: "Group not found" };
  }

  // Get the source workflow run to find the project
  const sourceRun = db
    .select()
    .from(schema.workflowRuns)
    .where(eq(schema.workflowRuns.id, group.sourceWorkflowRunId))
    .get();

  if (!sourceRun) {
    return { success: false, branch: "", mergedCount: 0, error: "Source run not found" };
  }

  // Find the stored target branch from the source run's first task
  const sourceFirstTask = db
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.workflowRunId, group.sourceWorkflowRunId))
    .all()
    .filter((t) => !t.originTaskId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];

  const storedTargetBranch = sourceFirstTask?.targetBranch || sourceFirstTask?.branch || null;

  const project = db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, sourceRun.projectId))
    .get();

  if (!project?.localPath) {
    return { success: false, branch: "", mergedCount: 0, error: "Project not found" };
  }

  const projectDir = project.localPath;

  // Get all completed child runs
  const childRuns = db
    .select()
    .from(schema.workflowRuns)
    .where(eq(schema.workflowRuns.parallelGroupId, groupId))
    .all()
    .filter((r) => r.status === "completed");

  if (childRuns.length === 0) {
    return { success: false, branch: "", mergedCount: 0, error: "No completed runs" };
  }

  // Create consolidation branch from current HEAD
  const shortGroupId = groupId.slice(0, 8);
  const consolidationBranch = `vibe-harness/consolidate-${shortGroupId}`;

  try {
    // Get current branch to return to on failure
    const currentBranch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: projectDir,
      encoding: "utf-8",
    }).trim();

    // Create the consolidation branch from current HEAD
    try {
      if (storedTargetBranch) {
        if (/[`$;&|<>(){}\\\n\r\0]/.test(storedTargetBranch) || storedTargetBranch.includes("..")) {
          throw new Error(`Invalid git ref: ${storedTargetBranch}`);
        }
        spawnSync("git", ["checkout", storedTargetBranch], {
          cwd: projectDir,
          stdio: "pipe",
        });
      }
      execSync(`git checkout -b "${consolidationBranch}"`, {
        cwd: projectDir,
        stdio: "pipe",
      });
    } catch {
      // Branch might already exist
      execSync(`git checkout "${consolidationBranch}"`, {
        cwd: projectDir,
        stdio: "pipe",
      });
    }

    // Merge each child run's branch sequentially
    let mergedCount = 0;
    for (const run of childRuns) {
      // Find the first task (origin) of this child run to get its branch name
      const firstTask = db
        .select()
        .from(schema.tasks)
        .where(eq(schema.tasks.workflowRunId, run.id))
        .all()
        .filter((t) => !t.originTaskId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];

      if (!firstTask) continue;

      const shortTaskId = firstTask.id.slice(0, 8);
      const taskBranch = `vibe-harness/task-${shortTaskId}`;

      try {
        const mergeMsg = `Merge sub-task ${shortTaskId}: ${(run.title || "sub-task").replace(/[^\w\s\-_./:]/g, "")}`;
        const mergeResult = spawnSync(
          "git", ["merge", taskBranch, "--no-ff", "-m", mergeMsg],
          { cwd: projectDir, stdio: "pipe" }
        );
        if (mergeResult.status !== 0) {
          throw new Error(mergeResult.stderr?.toString() || "merge failed");
        }
        mergedCount++;

        // Delete the child branch — merged into consolidation branch
        try {
          spawnSync("git", ["branch", "-D", taskBranch], { cwd: projectDir, stdio: "pipe" });
        } catch { /* non-critical */ }
      } catch (e) {
        // Merge conflict — abort and report
        try {
          execSync("git merge --abort", { cwd: projectDir, stdio: "pipe" });
        } catch {
          // ignore
        }
        // Return to original branch
        execSync(`git checkout "${currentBranch}"`, {
          cwd: projectDir,
          stdio: "pipe",
        });

        db.update(schema.parallelGroups)
          .set({ status: "failed" })
          .where(eq(schema.parallelGroups.id, groupId))
          .run();

        return {
          success: false,
          branch: consolidationBranch,
          mergedCount,
          error: `Merge conflict on branch ${taskBranch}: ${(e as Error).message}`,
        };
      }
    }

    // Switch back to original branch and merge consolidation
    execSync(`git checkout "${currentBranch}"`, {
      cwd: projectDir,
      stdio: "pipe",
    });
    const finalMerge = spawnSync(
      "git", ["merge", consolidationBranch, "--no-ff", "-m", `Merge parallel group ${shortGroupId}`],
      { cwd: projectDir, stdio: "pipe" }
    );
    if (finalMerge.status !== 0) {
      throw new Error(finalMerge.stderr?.toString() || "final merge failed");
    }

    // Clean up child worktrees
    for (const run of childRuns) {
      const firstTask = db
        .select()
        .from(schema.tasks)
        .where(eq(schema.tasks.workflowRunId, run.id))
        .all()
        .filter((t) => !t.originTaskId)[0];

      if (firstTask) {
        const shortId = firstTask.id.slice(0, 8);
        const worktreePath = path.join(projectDir, WORKTREE_DIR, shortId);
        if (fs.existsSync(worktreePath)) {
          try {
            execSync(`git worktree remove "${worktreePath}" --force`, {
              cwd: projectDir,
              stdio: "pipe",
            });
          } catch {
            fs.rmSync(worktreePath, { recursive: true, force: true });
          }
        }
      }
    }

    // Clean up consolidation branch
    try {
      execSync(`git branch -d "${consolidationBranch}"`, {
        cwd: projectDir,
        stdio: "pipe",
      });
    } catch {
      // non-critical
    }

    // Mark group as completed
    db.update(schema.parallelGroups)
      .set({ status: "completed", completedAt: new Date().toISOString() })
      .where(eq(schema.parallelGroups.id, groupId))
      .run();

    return { success: true, branch: consolidationBranch, mergedCount };
  } catch (e) {
    const msg = (e as Error).message;
    db.update(schema.parallelGroups)
      .set({ status: "failed" })
      .where(eq(schema.parallelGroups.id, groupId))
      .run();
    return { success: false, branch: consolidationBranch, mergedCount: 0, error: msg };
  }
}
