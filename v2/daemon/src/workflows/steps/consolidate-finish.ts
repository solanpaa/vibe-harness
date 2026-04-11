// ---------------------------------------------------------------------------
// Consolidate Finish Step (CDD-workflow §3.3)
//
// Performs the post-review consolidation phases: fast-forward parent worktree
// to the consolidation branch and clean up child worktrees/branches.
// Called ONLY after the consolidation review hook resumes with 'approve'.
// (Fix #5, SAD §5.3.5, §5.5.3)
// ---------------------------------------------------------------------------
"use step";

import { getDb } from '../../db/index.js';
import * as schema from '../../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { logger } from '../../lib/logger.js';
import type { WorktreeService } from '../../services/worktree.js';
import type { SessionManager } from '../../services/session-manager.js';

// ── Types ────────────────────────────────────────────────────────────

export interface ConsolidateFinishInput {
  parentRunId: string;
  parallelGroupId: string;
}

export interface ConsolidateFinishDeps {
  worktreeService: WorktreeService;
  sessionManager: SessionManager;
}

// ── Step implementation ──────────────────────────────────────────────

/**
 * Fix #5: This step is the second half of the consolidation flow.
 * consolidate() merges child branches and stops at phase='merged'.
 * This step resumes from 'merged' and performs ff_parent + cleanup.
 *
 * It is called ONLY after the consolidation review hook resumes with
 * 'approve'. This ensures the parent worktree is not modified until
 * the user has reviewed the combined diff.
 */
export async function consolidateFinish(
  input: ConsolidateFinishInput,
  deps: ConsolidateFinishDeps,
): Promise<void> {
  const { parentRunId, parallelGroupId } = input;
  const log = logger.child({ parentRunId, parallelGroupId, op: 'consolidate-finish' });
  const db = getDb();

  // ── Load journal — must exist and be in 'merged' phase ────────────
  const journal = db
    .select()
    .from(schema.gitOperations)
    .where(
      and(
        eq(schema.gitOperations.workflowRunId, parentRunId),
        eq(schema.gitOperations.type, 'consolidate'),
      ),
    )
    .get();

  if (!journal) {
    throw new Error(`No consolidation journal found for run ${parentRunId}`);
  }

  if (journal.phase === 'done') {
    log.info('Consolidation finish already completed');
    return;
  }

  if (journal.phase !== 'merged' && journal.phase !== 'ff_parent' && journal.phase !== 'cleanup') {
    throw new Error(
      `Unexpected journal phase '${journal.phase}' for consolidate-finish. ` +
      `Expected 'merged', 'ff_parent', or 'cleanup'.`,
    );
  }

  const parentRun = db
    .select({
      worktreePath: schema.workflowRuns.worktreePath,
      branch: schema.workflowRuns.branch,
      projectId: schema.workflowRuns.projectId,
    })
    .from(schema.workflowRuns)
    .where(eq(schema.workflowRuns.id, parentRunId))
    .get();

  if (!parentRun?.worktreePath) {
    throw new Error(`Parent run ${parentRunId} has no worktree`);
  }

  const project = db
    .select({ localPath: schema.projects.localPath })
    .from(schema.projects)
    .where(eq(schema.projects.id, parentRun.projectId))
    .get();

  if (!project) {
    throw new Error(`Project not found for parent run ${parentRunId}`);
  }

  const projectPath = project.localPath;
  const metadata = JSON.parse(journal.metadata ?? '{}');

  // ── Phase: ff_parent ──────────────────────────────────────────────
  if (journal.phase === 'merged' || journal.phase === 'ff_parent') {
    // Fast-forward the parent's branch to include all the merged changes.
    // The consolidation branch contains the merged result of all children.
    await deps.worktreeService.fastForwardMerge(
      projectPath,
      parentRun.branch!,
      metadata.consolidationBranch,
    );

    advancePhase(db, journal.id, 'cleanup', metadata);
  }

  // ── Phase: cleanup ────────────────────────────────────────────────
  const cleanupCheck = db
    .select({ phase: schema.gitOperations.phase })
    .from(schema.gitOperations)
    .where(eq(schema.gitOperations.id, journal.id))
    .get();

  if (cleanupCheck?.phase === 'cleanup') {
    // Remove child worktrees, branches, and stop child sessions
    for (const childRunId of metadata.mergedChildren ?? []) {
      const childRun = db
        .select({
          worktreePath: schema.workflowRuns.worktreePath,
          branch: schema.workflowRuns.branch,
        })
        .from(schema.workflowRuns)
        .where(eq(schema.workflowRuns.id, childRunId))
        .get();

      // Stop child session (best-effort)
      try {
        await deps.sessionManager.stop(childRunId);
      } catch {
        // Session may already be gone
      }

      if (childRun?.worktreePath) {
        await deps.worktreeService.remove(projectPath, childRun.worktreePath, {
          deleteBranch: childRun.branch ?? undefined,
        });
      }
    }

    // Clean up consolidation branch (best-effort)
    try {
      const { execSync } = await import('node:child_process');
      execSync(`git branch -D ${metadata.consolidationBranch}`, {
        cwd: projectPath,
        encoding: 'utf-8',
        stdio: 'pipe',
      });
    } catch {
      // Branch may not exist or already deleted
    }

    advancePhase(db, journal.id, 'done', metadata);

    // Update parallel group status
    db.update(schema.parallelGroups)
      .set({ status: 'completed', completedAt: new Date().toISOString() })
      .where(eq(schema.parallelGroups.id, parallelGroupId))
      .run();
  }

  log.info('Consolidation finish completed');
}

// ── Helpers ──────────────────────────────────────────────────────────

function advancePhase(
  db: ReturnType<typeof getDb>,
  journalId: string,
  phase: string,
  metadata: Record<string, unknown>,
): void {
  db.update(schema.gitOperations)
    .set({
      phase,
      metadata: JSON.stringify(metadata),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(schema.gitOperations.id, journalId))
    .run();
}
