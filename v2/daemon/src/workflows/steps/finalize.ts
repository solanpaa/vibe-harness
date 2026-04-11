// ---------------------------------------------------------------------------
// Finalize Step (CDD-workflow §3.7)
//
// Final git operations: commit → rebase → merge → cleanup.
// Uses the durable gitOperations journal for crash recovery.
// Each phase is idempotent (check before act).
// ---------------------------------------------------------------------------
"use step";

import { getDb } from '../../db/index.js';
import * as schema from '../../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { logger } from '../../lib/logger.js';
import type { WorktreeService } from '../../services/worktree.js';
import type { SessionManager } from '../../services/session-manager.js';

// ── Types ────────────────────────────────────────────────────────────

export interface FinalizeInput {
  runId: string;
  targetBranch: string;
}

export interface FinalizeOutput {
  conflict: boolean;
}

export interface FinalizeDeps {
  worktreeService: WorktreeService;
  sessionManager: SessionManager;
}

// ── Step implementation ──────────────────────────────────────────────

export async function finalize(
  input: FinalizeInput,
  deps: FinalizeDeps,
): Promise<FinalizeOutput> {
  const { runId, targetBranch } = input;
  const log = logger.child({ runId, targetBranch });
  const db = getDb();

  // ── Load or resume journal (SAD §5.5.3) ───────────────────────────
  let journal = db
    .select()
    .from(schema.gitOperations)
    .where(
      and(
        eq(schema.gitOperations.workflowRunId, runId),
        eq(schema.gitOperations.type, 'finalize'),
      ),
    )
    .get();

  if (journal?.phase === 'done') {
    log.info('Finalization already completed');
    return { conflict: false };
  }

  const run = db
    .select({
      worktreePath: schema.workflowRuns.worktreePath,
      branch: schema.workflowRuns.branch,
      projectId: schema.workflowRuns.projectId,
    })
    .from(schema.workflowRuns)
    .where(eq(schema.workflowRuns.id, runId))
    .get();

  if (!run?.worktreePath || !run?.branch) {
    throw new Error(`Run ${runId} missing worktree or branch`);
  }

  const project = db
    .select({ localPath: schema.projects.localPath })
    .from(schema.projects)
    .where(eq(schema.projects.id, run.projectId))
    .get();

  if (!project) {
    throw new Error(`Project not found for run ${runId}`);
  }

  const projectPath = project.localPath;
  const metadata = journal
    ? JSON.parse(journal.metadata ?? '{}')
    : { targetBranch };

  // Create journal entry if new
  if (!journal) {
    const journalId = crypto.randomUUID();
    db.insert(schema.gitOperations)
      .values({
        id: journalId,
        type: 'finalize',
        workflowRunId: runId,
        phase: 'commit',
        metadata: JSON.stringify(metadata),
      })
      .run();
    journal = { id: journalId, phase: 'commit', metadata: JSON.stringify(metadata) } as NonNullable<typeof journal>;
  }

  // ── Phase: commit ─────────────────────────────────────────────────
  if (journal!.phase === 'commit') {
    const commitResult = await deps.worktreeService.commitAll(
      projectPath,
      run.worktreePath,
      'Final commit from Vibe Harness workflow',
    );
    log.info({ committed: commitResult.committed }, 'Commit phase done');
    advancePhase(db, journal!.id, 'rebase', metadata);
  }

  // ── Phase: rebase ─────────────────────────────────────────────────
  if (journal!.phase === 'rebase' || (journal!.phase === 'commit')) {
    // Re-read phase in case commit just advanced it
    const currentJournal = db
      .select({ phase: schema.gitOperations.phase })
      .from(schema.gitOperations)
      .where(eq(schema.gitOperations.id, journal!.id))
      .get();

    if (currentJournal?.phase === 'rebase') {
      const rebaseResult = await deps.worktreeService.rebase(
        projectPath,
        run.worktreePath,
        targetBranch,
      );

      if (!rebaseResult.success) {
        log.warn({ conflictFiles: rebaseResult.conflictFiles }, 'Rebase conflict detected');
        return { conflict: true };
      }

      advancePhase(db, journal!.id, 'merge', metadata);
    }
  }

  // ── Phase: merge (fast-forward into target) ───────────────────────
  const mergeCheck = db
    .select({ phase: schema.gitOperations.phase })
    .from(schema.gitOperations)
    .where(eq(schema.gitOperations.id, journal!.id))
    .get();

  if (mergeCheck?.phase === 'merge') {
    await deps.worktreeService.fastForwardMerge(
      projectPath,
      run.branch,
      targetBranch,
    );
    advancePhase(db, journal!.id, 'cleanup', metadata);
  }

  // ── Phase: cleanup ────────────────────────────────────────────────
  const cleanupCheck = db
    .select({ phase: schema.gitOperations.phase })
    .from(schema.gitOperations)
    .where(eq(schema.gitOperations.id, journal!.id))
    .get();

  if (cleanupCheck?.phase === 'cleanup') {
    // Stop session (best-effort)
    try {
      await deps.sessionManager.stop(runId);
    } catch {
      // Sandbox may already be gone
    }

    // Remove worktree and branch
    await deps.worktreeService.remove(projectPath, run.worktreePath, {
      deleteBranch: run.branch,
    });

    // Clear run references
    db.update(schema.workflowRuns)
      .set({
        sandboxId: null,
        worktreePath: null,
        completedAt: new Date().toISOString(),
      })
      .where(eq(schema.workflowRuns.id, runId))
      .run();

    advancePhase(db, journal!.id, 'done', metadata);
  }

  log.info('Finalization completed');
  return { conflict: false };
}

// --- Helpers ------------------------------------------------------------- //

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
