/**
 * Public API for state machine transitions.
 *
 * Reads/writes state from SQLite via Drizzle ORM. Delegates transition
 * logic to xstate machines via the persistence engine.
 */

import { getDb, schema } from "@/lib/db";
import { eq, sql, desc } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { applyTransition } from "./engine";
import { taskMachine } from "./machines/task";
import { workflowRunMachine } from "./machines/workflow-run";
import { getStageConfig, getNextStage, buildStagePrompt } from "@/lib/services/workflow-config";
import { createReviewForTask } from "@/lib/services/review-service";
import { rerunWithComments } from "@/lib/services/review-rerun";
import { startTask, setTransitionTask } from "@/lib/services/task-manager";
import { launchProposals } from "@/lib/services/parallel-launcher";
import type {
  TransitionResult,
  TaskEvent,
  WorkflowRunEvent,
  WorkflowRunContext,
} from "./types";
import type { WorkflowStage } from "@/types/domain";

export { taskMachine } from "./machines/task";
export { workflowRunMachine } from "./machines/workflow-run";
export type {
  TransitionResult,
  TaskEvent,
  TaskContext,
  WorkflowRunEvent,
  WorkflowRunContext,
} from "./types";

/**
 * Transition a task. Reads current state from DB, applies the xstate
 * transition, writes back, and executes side-effect actions.
 */
export async function transitionTask(
  taskId: string,
  event: TaskEvent
): Promise<TransitionResult> {
  return applyTransition<Record<string, unknown>, TaskEvent>({
    machine: taskMachine,
    entityId: taskId,
    event,
    readState: (id) => {
      const db = getDb();
      const task = db
        .select()
        .from(schema.tasks)
        .where(eq(schema.tasks.id, id))
        .get();
      if (!task) throw new Error(`Task ${id} not found`);
      return {
        status: task.status,
        context: {
          taskId: task.id,
          workflowRunId: task.workflowRunId,
          originTaskId: task.originTaskId,
        } as unknown as Record<string, unknown>,
      };
    },
    writeState: (id, status, expectedFromStatus) => {
      const db = getDb();
      // Optimistic lock: only update if status matches expected
      const result = db
        .update(schema.tasks)
        .set({ status })
        .where(
          sql`${schema.tasks.id} = ${id} AND ${schema.tasks.status} = ${expectedFromStatus}`
        )
        .run();
      if (result.changes === 0) {
        throw new Error(
          `Optimistic lock failed for task ${id}: expected status "${expectedFromStatus}"`
        );
      }
    },
    actionHandlers: {
      saveOutput: (ctx, evt) => {
        const db = getDb();
        const e = evt as TaskEvent & { output?: string; lastAiMessage?: string | null; exitCode?: number; usageStats?: string | null };
        db.update(schema.tasks)
          .set({
            output: e.output ?? null,
            lastAiMessage: e.lastAiMessage ?? null,
            exitCode: e.exitCode ?? null,
            usageStats: e.usageStats ?? null,
          })
          .where(eq(schema.tasks.id, taskId))
          .run();
      },
      setCompletedAt: () => {
        const db = getDb();
        db.update(schema.tasks)
          .set({ completedAt: new Date().toISOString() })
          .where(eq(schema.tasks.id, taskId))
          .run();
      },
      setSandboxId: (_ctx, evt) => {
        const db = getDb();
        const e = evt as TaskEvent & { sandboxId?: string };
        if (e.sandboxId) {
          db.update(schema.tasks)
            .set({ sandboxId: e.sandboxId })
            .where(eq(schema.tasks.id, taskId))
            .run();
        }
      },
      notifyWorkflow: async (_ctx, evt) => {
        const c = _ctx as unknown as { workflowRunId: string };
        if (!c.workflowRunId) return;

        // Derive event type from the triggering event — don't re-read DB
        const eventType = evt.type === "FAIL" ? "TASK_FAILED" : "TASK_COMPLETED";

        try {
          await transitionWorkflowRun(c.workflowRunId, {
            type: eventType,
            taskId,
          } as WorkflowRunEvent);
        } catch (err) {
          console.error(`[StateMachine] Failed to notify workflow ${c.workflowRunId}:`, err);
        }
      },
    },
  });
}

// Inject transitionTask into task-manager to break circular dependency.
// task-manager needs transitionTask for START/COMPLETE/FAIL/PAUSE,
// and this module needs startTask from task-manager for launching tasks.
setTransitionTask((taskId, event) => transitionTask(taskId, event as TaskEvent));

/**
 * Transition a workflow run. Reads current state from DB, applies the
 * xstate transition, writes back, and executes side-effect actions.
 */
export async function transitionWorkflowRun(
  workflowRunId: string,
  event: WorkflowRunEvent
): Promise<TransitionResult> {
  const result = await applyTransition<Record<string, unknown>, WorkflowRunEvent>({
    machine: workflowRunMachine,
    entityId: workflowRunId,
    event,
    readState: (id) => {
      const db = getDb();
      const run = db
        .select()
        .from(schema.workflowRuns)
        .where(eq(schema.workflowRuns.id, id))
        .get();
      if (!run) throw new Error(`Workflow run ${id} not found`);

      // Resolve stage config for guards
      let autoAdvance = false;
      let isLastStage = false;
      const currentStageName = run.currentStage;

      if (currentStageName && currentStageName !== "finalize") {
        const stageConfig = getStageConfig(id, currentStageName);
        autoAdvance = stageConfig?.autoAdvance === true;

        // Determine if this is the last stage
        const template = db
          .select()
          .from(schema.workflowTemplates)
          .where(eq(schema.workflowTemplates.id, run.workflowTemplateId))
          .get();
        if (template) {
          const stages: WorkflowStage[] = JSON.parse(template.stages);
          const idx = stages.findIndex((s) => s.name === currentStageName);
          isLastStage = idx >= 0 && idx >= stages.length - 1;

          // Dynamic stages (e.g., "split") aren't in the template.
          // Check if there's a next stage — if not, it's the last.
          if (!isLastStage && idx === -1) {
            const commitStage = stages.find((s) => s.name === "commit");
            if (!commitStage) isLastStage = true;
          }
        }
      }

      // Check if all child workflows are done (for running_parallel)
      // Child runs link to the parent via a parallel group:
      //   parallel_groups.sourceWorkflowRunId → this run
      //   child workflow_runs.parallelGroupId → parallel_groups.id
      let allChildrenDone = false;
      if (run.status === "running_parallel") {
        const groups = db
          .select({ id: schema.parallelGroups.id })
          .from(schema.parallelGroups)
          .where(eq(schema.parallelGroups.sourceWorkflowRunId, id))
          .all();

        if (groups.length > 0) {
          const groupIds = groups.map((g) => g.id);
          const children = db
            .select({ status: schema.workflowRuns.status })
            .from(schema.workflowRuns)
            .all()
            .filter((r) => r.status !== undefined && groupIds.includes((r as any).parallelGroupId));

          // Use a raw query to find children by parallelGroupId
          const allChildren: { status: string }[] = [];
          for (const gid of groupIds) {
            const kids = db
              .select({ status: schema.workflowRuns.status })
              .from(schema.workflowRuns)
              .where(eq(schema.workflowRuns.parallelGroupId, gid))
              .all();
            allChildren.push(...kids);
          }

          allChildrenDone = allChildren.length > 0 &&
            allChildren.every((c) =>
              c.status === "completed" || c.status === "failed" || c.status === "cancelled"
            );
        }
      }

      // Find current (non-terminal) task for this workflow run — single query
      const currentTask = db
        .select({ id: schema.tasks.id, status: schema.tasks.status })
        .from(schema.tasks)
        .where(eq(schema.tasks.workflowRunId, id))
        .all()
        .filter((t) =>
          t.status !== "completed" && t.status !== "failed" && t.status !== "cancelled"
        )
        .pop();

      return {
        status: run.status,
        context: {
          workflowRunId: run.id,
          workflowTemplateId: run.workflowTemplateId,
          projectId: run.projectId,
          currentStage: run.currentStage,
          currentStageName,
          currentTaskId: currentTask?.id ?? null,
          taskDescription: run.taskDescription,
          acpSessionId: run.acpSessionId,
          autoAdvance,
          isLastStage,
          allChildrenDone,
        } as unknown as Record<string, unknown>,
      };
    },
    writeState: (id, status, expectedFromStatus) => {
      const db = getDb();
      const result = db
        .update(schema.workflowRuns)
        .set({ status })
        .where(
          sql`${schema.workflowRuns.id} = ${id} AND ${schema.workflowRuns.status} = ${expectedFromStatus}`
        )
        .run();
      if (result.changes === 0) {
        throw new Error(
          `Optimistic lock failed for workflow run ${id}: expected status "${expectedFromStatus}"`
        );
      }
    },
    actionHandlers: {
      setCurrentStage: () => {
        // Stage is set by advanceToNextStage/launchNextStageTask or by the route
        // via a follow-up DB update. No standalone work needed here.
      },
      setCompletedAt: () => {
        const db = getDb();
        db.update(schema.workflowRuns)
          .set({ completedAt: new Date().toISOString() })
          .where(eq(schema.workflowRuns.id, workflowRunId))
          .run();
      },
      createReview: async (_ctx, evt) => {
        const e = evt as WorkflowRunEvent & { taskId?: string };
        if (e.taskId) {
          try {
            await createReviewForTask(e.taskId);
          } catch (err) {
            console.error("[StateMachine] Failed to create review:", err);
            throw err;
          }
        }
      },
      createMergeConflictReview: () => {
        // Create a review record indicating a merge conflict needs resolution
        const db = getDb();
        const currentTask = db
          .select()
          .from(schema.tasks)
          .where(eq(schema.tasks.workflowRunId, workflowRunId))
          .all()
          .filter((t) => t.status === "completed")
          .pop();

        if (currentTask) {
          const reviewId = uuid();
          db.insert(schema.reviews)
            .values({
              id: reviewId,
              workflowRunId,
              taskId: currentTask.id,
              round: 1,
              status: "pending_review",
              aiSummary: "## Merge Conflict\n\nThe automatic merge failed due to conflicts. Please resolve the conflicts manually and re-approve.",
              diffSnapshot: "",
              createdAt: new Date().toISOString(),
            })
            .run();
        }
      },
      createConsolidationReview: async () => {
        // Create a review showing ALL changes from the parallel children.
        // After consolidation, changes are merged into the main working tree.
        // We diff the origin task's branch base against main's current HEAD.
        const db = getDb();
        const { execFileSync } = await import("child_process");

        const originTask = db
          .select()
          .from(schema.tasks)
          .where(eq(schema.tasks.workflowRunId, workflowRunId))
          .all()
          .filter((t) => !t.originTaskId)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];

        if (!originTask) return;

        const project = db
          .select()
          .from(schema.projects)
          .where(eq(schema.projects.id, originTask.projectId))
          .get();
        if (!project) return;

        // Diff: what changed between the origin task's branch point and current main
        const shortId = originTask.id.slice(0, 8);
        const originBranch = `vibe-harness/task-${shortId}`;
        let diffText = "";
        try {
          diffText = execFileSync("git", ["diff", `${originBranch}..HEAD`], {
            cwd: project.localPath,
            encoding: "utf-8",
            maxBuffer: 10 * 1024 * 1024,
          });
        } catch {
          diffText = "<!-- Could not generate consolidation diff -->";
        }

        // Parse diff for summary
        const { parseUnifiedDiff, diffSummary } = await import("@/lib/services/diff-service");
        const files = parseUnifiedDiff(diffText);
        const totalAdded = files.reduce((s, f) => s + f.additions, 0);
        const totalDeleted = files.reduce((s, f) => s + f.deletions, 0);

        let summary = `## Consolidation Review\n\n`;
        summary += `Merged changes from all parallel sub-tasks.\n\n`;
        summary += `**${files.length}** file(s) changed, **${totalAdded}** insertions(+), **${totalDeleted}** deletions(-)\n\n`;
        if (files.length > 0) {
          summary += `| File | Status | Changes |\n|------|--------|---------|\n`;
          for (const f of files) {
            const status = f.status === "added" ? "🟢 Added" : f.status === "deleted" ? "🔴 Deleted" : "🟡 Modified";
            summary += `| \`${f.path}\` | ${status} | +${f.additions} -${f.deletions} |\n`;
          }
        }

        // Count existing reviews for round number
        const existingReviews = db
          .select()
          .from(schema.reviews)
          .where(eq(schema.reviews.workflowRunId, workflowRunId))
          .all();

        const reviewId = uuid();
        db.insert(schema.reviews)
          .values({
            id: reviewId,
            workflowRunId,
            taskId: originTask.id,
            round: existingReviews.length + 1,
            status: "pending_review",
            aiSummary: summary,
            diffSnapshot: diffText,
            createdAt: new Date().toISOString(),
          })
          .run();
      },
      setReviewApproved: (_ctx, evt) => {
        const e = evt as WorkflowRunEvent & { reviewId?: string };
        if (e.reviewId) {
          const db = getDb();
          db.update(schema.reviews)
            .set({ status: "approved" })
            .where(eq(schema.reviews.id, e.reviewId))
            .run();
        }
      },
      setReviewChangesRequested: (_ctx, evt) => {
        const e = evt as WorkflowRunEvent & { reviewId?: string };
        if (e.reviewId) {
          const db = getDb();
          db.update(schema.reviews)
            .set({ status: "changes_requested" })
            .where(eq(schema.reviews.id, e.reviewId))
            .run();
        }
      },
      advanceToNextStage: async () => {
        await launchNextStageForWorkflow(workflowRunId);
      },
      launchNextStageTask: async () => {
        await launchNextStageForWorkflow(workflowRunId);
      },
      launchSplitTask: async (_ctx, evt) => {
        const e = evt as WorkflowRunEvent & { reviewId?: string };
        await launchSplitTaskForWorkflow(workflowRunId, e.reviewId);
      },
      spawnRerunTask: async (_ctx, evt) => {
        const e = evt as WorkflowRunEvent & { reviewId?: string };
        if (e.reviewId) {
          try {
            await rerunWithComments(e.reviewId);
          } catch (err) {
            console.error("[StateMachine] Failed to spawn rerun task:", err);
          }
        }
      },
      rerunSplitStage: async (_ctx, evt) => {
        // REQUEST_CHANGES on awaiting_split_review — rerun the split agent
        const e = evt as WorkflowRunEvent & { reviewId?: string };
        if (e.reviewId) {
          try {
            await rerunWithComments(e.reviewId);
          } catch (err) {
            console.error("[StateMachine] Failed to rerun split stage:", err);
          }
        }
      },
      createParallelGroup: async (_ctx, evt) => {
        const e = evt as WorkflowRunEvent & {
          taskId?: string;
          proposalIds?: string[];
          workflowTemplateId?: string;
          useFullWorkflow?: boolean;
        };
        if (e.taskId) {
          try {
            await launchProposals({
              taskId: e.taskId,
              proposalIds: e.proposalIds,
              workflowTemplateId: e.workflowTemplateId,
              useFullWorkflow: e.useFullWorkflow,
            });
          } catch (err) {
            console.error("[StateMachine] Failed to launch proposals:", err);
          }
        }
      },
      launchChildWorkflows: () => {
        // Handled by createParallelGroup (launchProposals does both)
      },
      setParallelGroupCompleted: () => {
        const db = getDb();
        const groups = db
          .select({ id: schema.parallelGroups.id })
          .from(schema.parallelGroups)
          .where(eq(schema.parallelGroups.sourceWorkflowRunId, workflowRunId))
          .all();
        for (const g of groups) {
          db.update(schema.parallelGroups)
            .set({ status: "completed", completedAt: new Date().toISOString() })
            .where(eq(schema.parallelGroups.id, g.id))
            .run();
        }
      },
      setParallelGroupFailed: () => {
        const db = getDb();
        const groups = db
          .select({ id: schema.parallelGroups.id })
          .from(schema.parallelGroups)
          .where(eq(schema.parallelGroups.sourceWorkflowRunId, workflowRunId))
          .all();
        for (const g of groups) {
          db.update(schema.parallelGroups)
            .set({ status: "failed" })
            .where(eq(schema.parallelGroups.id, g.id))
            .run();
        }
      },
      pauseCurrentTask: async (_ctx) => {
        const c = _ctx as unknown as WorkflowRunContext;
        if (c.currentTaskId) {
          try {
            const { stopTask } = await import("@/lib/services/task-manager");
            await stopTask(c.currentTaskId);
          } catch (err) {
            console.error("[StateMachine] Failed to pause current task:", err);
          }
        }
      },
      resumeCurrentTask: async (_ctx) => {
        const c = _ctx as unknown as WorkflowRunContext;
        if (!c.currentTaskId) return;

        try {
          // Transition task from paused → running
          await transitionTask(c.currentTaskId, { type: "RESUME" });

          // Restart the agent in the existing sandbox
          const db = getDb();
          const task = db.select().from(schema.tasks).where(eq(schema.tasks.id, c.currentTaskId)).get();
          if (!task) return;

          const project = db.select().from(schema.projects).where(eq(schema.projects.id, task.projectId)).get();
          if (!project) return;

          const agent = db.select().from(schema.agentDefinitions).where(eq(schema.agentDefinitions.id, task.agentDefinitionId)).get();
          if (!agent) return;

          let loadSessionId: string | null = null;
          if (task.workflowRunId) {
            const run = db.select({ acpSessionId: schema.workflowRuns.acpSessionId })
              .from(schema.workflowRuns).where(eq(schema.workflowRuns.id, task.workflowRunId)).get();
            loadSessionId = run?.acpSessionId || null;
          }

          startTask({
            taskId: c.currentTaskId,
            projectDir: project.localPath,
            agentCommand: agent.commandTemplate || "copilot",
            credentialSetId: task.credentialSetId,
            dockerImage: agent.dockerImage,
            prompt: "Please continue where you left off.",
            model: task.model,
            useWorktree: task.useWorktree === 1,
            originTaskId: task.originTaskId || task.id,
            isContinuation: true,
            loadSessionId,
          });
        } catch (err) {
          console.error("[StateMachine] Failed to resume current task:", err);
        }
      },
      cancelCurrentTask: async (_ctx) => {
        const c = _ctx as unknown as WorkflowRunContext;
        if (c.currentTaskId) {
          try {
            await transitionTask(c.currentTaskId, { type: "CANCEL" });
          } catch (err) {
            console.error("[StateMachine] Failed to cancel current task:", err);
          }
        }
      },
      cancelChildWorkflows: async () => {
        const db = getDb();
        const groups = db
          .select({ id: schema.parallelGroups.id })
          .from(schema.parallelGroups)
          .where(eq(schema.parallelGroups.sourceWorkflowRunId, workflowRunId))
          .all();
        for (const g of groups) {
          const childRuns = db
            .select({ id: schema.workflowRuns.id, status: schema.workflowRuns.status })
            .from(schema.workflowRuns)
            .where(eq(schema.workflowRuns.parallelGroupId, g.id))
            .all();
          for (const child of childRuns) {
            if (child.status !== "completed" && child.status !== "failed" && child.status !== "cancelled") {
              try {
                await transitionWorkflowRun(child.id, { type: "CANCEL" });
              } catch (err) {
                console.error(`[StateMachine] Failed to cancel child workflow ${child.id}:`, err);
              }
            }
          }
        }
      },
      cleanupSandboxes: async () => {
        const db = getDb();
        const { execFileSync } = await import("child_process");
        const { removeWorktree } = await import("@/lib/services/worktree");

        // Collect task info for this workflow's tasks
        const tasks = db
          .select({
            id: schema.tasks.id,
            sandboxId: schema.tasks.sandboxId,
            originTaskId: schema.tasks.originTaskId,
            projectId: schema.tasks.projectId,
          })
          .from(schema.tasks)
          .where(eq(schema.tasks.workflowRunId, workflowRunId))
          .all();

        // Clean up sandboxes
        const sandboxIds = [...new Set(
          tasks.map((t) => t.sandboxId).filter(Boolean) as string[]
        )];

        for (const sandboxId of sandboxIds) {
          try {
            execFileSync("docker", ["sandbox", "stop", sandboxId], { stdio: "pipe", timeout: 15000 });
            execFileSync("docker", ["sandbox", "rm", sandboxId], { stdio: "pipe", timeout: 15000 });
            console.log(`[StateMachine] Cleaned up sandbox ${sandboxId}`);
          } catch {
            // Sandbox may already be stopped/removed
          }
        }

        // Clean up worktrees and branches for all tasks in this workflow.
        // Worktrees are keyed by origin task ID (shared across a chain).
        const projectId = tasks[0]?.projectId;
        const project = projectId
          ? db.select({ localPath: schema.projects.localPath })
              .from(schema.projects).where(eq(schema.projects.id, projectId)).get()
          : null;

        if (project?.localPath) {
          // Collect unique task IDs that own worktrees (origin or self)
          const worktreeTaskIds = [...new Set(
            tasks.map((t) => t.originTaskId || t.id)
          )];

          for (const taskId of worktreeTaskIds) {
            try {
              removeWorktree(project.localPath, taskId);
              console.log(`[StateMachine] Cleaned up worktree for task ${taskId.slice(0, 8)}`);
            } catch (err) {
              console.warn(`[StateMachine] Worktree cleanup failed for ${taskId.slice(0, 8)}:`, err);
            }

            // Delete the branch
            const shortId = taskId.slice(0, 8);
            const branch = `vibe-harness/task-${shortId}`;
            try {
              execFileSync("git", ["branch", "-D", branch], {
                cwd: project.localPath,
                stdio: "pipe",
                timeout: 10000,
              });
              console.log(`[StateMachine] Deleted branch ${branch}`);
            } catch {
              // Branch may not exist or already deleted
            }
          }
        }
      },
    },
  });

  // After a workflow reaches a terminal state, check if it's a child in a
  // parallel group — if all siblings are done, auto-consolidate the parent.
  if (result.ok) {
    const terminalStates = ["completed", "failed", "cancelled"];
    if (terminalStates.includes(result.to)) {
      try {
        await checkAutoConsolidate(workflowRunId);
      } catch (err) {
        console.error("[StateMachine] Auto-consolidation check failed:", err);
      }
    }
  }

  // Log failed side-effect actions for monitoring
  if (result.ok && result.failedActions && result.failedActions.length > 0) {
    console.error(
      `[StateMachine] Transition ${result.event} on workflow ${workflowRunId} had ${result.failedActions.length} failed action(s):`,
      result.failedActions.join(", ")
    );
  }

  return result;
}

/**
 * Check if a workflow run is part of a parallel group, and if all siblings
 * are done, automatically consolidate and advance the parent workflow.
 */
async function checkAutoConsolidate(childWorkflowRunId: string) {
  const db = getDb();

  // Is this child part of a parallel group?
  const childRun = db
    .select({ parallelGroupId: schema.workflowRuns.parallelGroupId })
    .from(schema.workflowRuns)
    .where(eq(schema.workflowRuns.id, childWorkflowRunId))
    .get();

  if (!childRun?.parallelGroupId) return;

  const group = db
    .select()
    .from(schema.parallelGroups)
    .where(eq(schema.parallelGroups.id, childRun.parallelGroupId))
    .get();

  if (!group) return;

  // Check if ALL siblings are in terminal state
  const siblings = db
    .select({ status: schema.workflowRuns.status })
    .from(schema.workflowRuns)
    .where(eq(schema.workflowRuns.parallelGroupId, group.id))
    .all();

  const allDone = siblings.length > 0 &&
    siblings.every((s) =>
      s.status === "completed" || s.status === "failed" || s.status === "cancelled"
    );

  if (!allDone) return;

  console.log(`[StateMachine] All children done for group ${group.id} — auto-consolidating`);

  // Perform git consolidation
  const { consolidateParallelGroup } = await import("@/lib/services/parallel-launcher");
  const mergeResult = consolidateParallelGroup(group.id);

  // Transition the parent workflow
  if (mergeResult.success) {
    await transitionWorkflowRun(group.sourceWorkflowRunId, { type: "CONSOLIDATE" });
  } else if (mergeResult.error?.includes("conflict")) {
    await transitionWorkflowRun(group.sourceWorkflowRunId, { type: "MERGE_CONFLICT" });
  } else {
    await transitionWorkflowRun(group.sourceWorkflowRunId, { type: "FAIL" });
  }
}
async function launchNextStageForWorkflow(workflowRunId: string) {
  const db = getDb();

  const run = db
    .select()
    .from(schema.workflowRuns)
    .where(eq(schema.workflowRuns.id, workflowRunId))
    .get();
  if (!run || !run.currentStage) return;

  const nextStage = getNextStage(workflowRunId, run.currentStage);
  if (!nextStage) return;

  const project = db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, run.projectId))
    .get();
  if (!project) return;

  // Find the origin task for --continue
  const firstTask = db
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.workflowRunId, workflowRunId))
    .all()
    .filter((t) => !t.originTaskId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
  if (!firstTask) return;

  const agent = nextStage.agentDefinitionId
    ? db.select().from(schema.agentDefinitions)
        .where(eq(schema.agentDefinitions.id, nextStage.agentDefinitionId)).get()
    : db.select().from(schema.agentDefinitions)
        .where(eq(schema.agentDefinitions.id, firstTask.agentDefinitionId)).get();
  if (!agent) return;

  // For fresh-session stages, get plan context from previous reviews
  const isFreshSession = nextStage.freshSession === true;
  let previousPlan: string | null = null;
  if (isFreshSession) {
    const latestReview = db
      .select()
      .from(schema.reviews)
      .where(eq(schema.reviews.workflowRunId, workflowRunId))
      .orderBy(desc(schema.reviews.createdAt))
      .limit(1)
      .get();
    const reviewTask = latestReview
      ? db.select({ lastAiMessage: schema.tasks.lastAiMessage })
          .from(schema.tasks).where(eq(schema.tasks.id, latestReview.taskId)).get()
      : null;
    previousPlan = latestReview?.planMarkdown || latestReview?.aiSummary
      || reviewTask?.lastAiMessage || null;
  }

  const prompt = buildStagePrompt(
    run.taskDescription || firstTask.prompt,
    nextStage,
    previousPlan
  );

  const taskId = uuid();
  db.transaction((tx) => {
    tx.insert(schema.tasks)
      .values({
        id: taskId,
        projectId: run.projectId,
        workflowRunId,
        stageName: nextStage.name,
        agentDefinitionId: agent.id,
        credentialSetId: firstTask.credentialSetId,
        sandboxId: null,
        originTaskId: firstTask.id,
        status: "pending",
        prompt,
        model: firstTask.model,
        useWorktree: firstTask.useWorktree,
        branch: firstTask.branch,
        targetBranch: firstTask.targetBranch,
        output: null,
        createdAt: new Date().toISOString(),
        completedAt: null,
      })
      .run();

    tx.update(schema.workflowRuns)
      .set({ currentStage: nextStage.name })
      .where(eq(schema.workflowRuns.id, workflowRunId))
      .run();
  });

  // Provision and launch
  await transitionTask(taskId, { type: "PROVISION" });

  Promise.resolve().then(() => {
    try {
      startTask({
        taskId,
        projectDir: project.localPath,
        agentCommand: agent.commandTemplate || "copilot",
        dockerImage: agent.dockerImage,
        credentialSetId: firstTask.credentialSetId,
        prompt,
        model: firstTask.model,
        useWorktree: firstTask.useWorktree === 1,
        branch: firstTask.branch,
        isContinuation: !isFreshSession,
        originTaskId: firstTask.id,
        loadSessionId: isFreshSession ? null : (run.acpSessionId || null),
      });
    } catch (e) {
      console.error(`[StateMachine] Failed to launch stage ${nextStage.name}:`, e);
      transitionTask(taskId, { type: "FAIL" }).catch((e2) =>
        console.error(`[StateMachine] Also failed to mark task as FAIL:`, e2));
    }
  });
}

/**
 * Create and launch a split task for a workflow run.
 * Called when a reviewer chooses SPLIT — creates a task that decomposes
 * the work into proposals for parallel execution.
 */
async function launchSplitTaskForWorkflow(workflowRunId: string, reviewId?: string) {
  const db = getDb();

  const run = db
    .select()
    .from(schema.workflowRuns)
    .where(eq(schema.workflowRuns.id, workflowRunId))
    .get();
  if (!run) return;

  const project = db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, run.projectId))
    .get();
  if (!project) return;

  // Find the first (origin) task for sandbox/worktree reuse
  const firstTask = db
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.workflowRunId, workflowRunId))
    .all()
    .filter((t) => !t.originTaskId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
  if (!firstTask) return;

  const agent = db
    .select()
    .from(schema.agentDefinitions)
    .where(eq(schema.agentDefinitions.id, firstTask.agentDefinitionId))
    .get();
  if (!agent) return;

  // Get plan context from the review if available
  let planContext: string | null = null;
  if (reviewId) {
    const review = db
      .select()
      .from(schema.reviews)
      .where(eq(schema.reviews.id, reviewId))
      .get();
    planContext = review?.planMarkdown || review?.aiSummary || null;
  }

  // Import split stage prompt template
  const { getPlanAndSplitStages } = await import("@/lib/services/workflow-engine");
  const splitStages = getPlanAndSplitStages();
  const splitStage = splitStages.find((s) => s.name === "split")!;
  const prompt = buildStagePrompt(
    run.taskDescription || firstTask.prompt,
    splitStage,
    planContext
  );

  // Create the split task
  const splitTaskId = uuid();
  db.insert(schema.tasks)
    .values({
      id: splitTaskId,
      projectId: run.projectId,
      workflowRunId,
      stageName: "split",
      agentDefinitionId: firstTask.agentDefinitionId,
      credentialSetId: firstTask.credentialSetId,
      sandboxId: null,
      originTaskId: firstTask.id,
      status: "pending",
      prompt,
      model: firstTask.model,
      useWorktree: firstTask.useWorktree,
      branch: firstTask.branch,
      targetBranch: firstTask.targetBranch,
      output: null,
      createdAt: new Date().toISOString(),
      completedAt: null,
    })
    .run();

  // Update workflow stage
  db.update(schema.workflowRuns)
    .set({ currentStage: "split" })
    .where(eq(schema.workflowRuns.id, workflowRunId))
    .run();

  // Provision and launch
  await transitionTask(splitTaskId, { type: "PROVISION" });

  Promise.resolve().then(() => {
    try {
      startTask({
        taskId: splitTaskId,
        projectDir: project.localPath,
        agentCommand: agent.commandTemplate || "copilot",
        dockerImage: agent.dockerImage,
        credentialSetId: firstTask.credentialSetId,
        prompt,
        model: firstTask.model,
        useWorktree: firstTask.useWorktree === 1,
        branch: firstTask.branch,
        isContinuation: false,
        originTaskId: firstTask.id,
        loadSessionId: null,
      });
    } catch (e) {
      console.error("[StateMachine] Failed to launch split task:", e);
      transitionTask(splitTaskId, { type: "FAIL" }).catch((e2) =>
        console.error("[StateMachine] Also failed to mark split task as FAIL:", e2));
    }
  });
}
