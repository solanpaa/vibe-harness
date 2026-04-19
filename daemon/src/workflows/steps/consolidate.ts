// ---------------------------------------------------------------------------
// Consolidate Step (CDD-workflow §3.6)
//
// Merges completed child branches into a consolidation branch using the
// durable git operations journal. Fix #5: This step ONLY performs
// snapshot_parent and merge_children phases — it stops at phase 'merged'
// and returns. The ff_parent and cleanup phases are handled by the
// separate consolidate-finish.ts step, which runs ONLY after the
// consolidation review is approved.
// (SAD §5.5.3, SRD FR-S8–S10)
// ---------------------------------------------------------------------------
"use step";

import { getDb } from '../../db/index.js';
import * as schema from '../../db/schema.js';
import { eq, and, asc } from 'drizzle-orm';
import { logger } from '../../lib/logger.js';
import type { WorktreeService } from '../../services/worktree.js';

// ── Types ────────────────────────────────────────────────────────────

export interface ConsolidateInput {
  parentRunId: string;
  parallelGroupId: string;
}

export interface ConsolidateOutput {
  conflict: boolean;
  conflictChildId?: string;
  /** Summary of merged files for the consolidation review (Fix #14). */
  mergedFiles?: string;
}

export interface ConsolidateDeps {
  worktreeService: WorktreeService;
}

function resolveGlobalDeps(): ConsolidateDeps {
  const deps = (globalThis as any).__vibe_pipeline_deps__;
  if (!deps) throw new Error('Pipeline deps not initialized');
  return deps;
}

// ── Step implementation ──────────────────────────────────────────────

export async function consolidate(
  input: ConsolidateInput,
  depsOverride?: ConsolidateDeps,
): Promise<ConsolidateOutput> {
  const { parentRunId, parallelGroupId } = input;
  const log = logger.child({ parentRunId, parallelGroupId });
  const db = getDb();
  const deps = depsOverride ?? resolveGlobalDeps();

  // ── Load or resume journal (SAD §5.5.3) ───────────────────────────
  let journal = db
    .select()
    .from(schema.gitOperations)
    .where(
      and(
        eq(schema.gitOperations.workflowRunId, parentRunId),
        eq(schema.gitOperations.type, 'consolidate'),
      ),
    )
    .get();

  if (journal?.phase === 'done' || journal?.phase === 'merged') {
    log.info('Consolidation merge already completed');
    return { conflict: false };
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

  // Get completed children in sort order (SRD FR-S9)
  const completedChildren = db
    .select({ id: schema.workflowRuns.id })
    .from(schema.workflowRuns)
    .where(
      and(
        eq(schema.workflowRuns.parallelGroupId, parallelGroupId),
        eq(schema.workflowRuns.status, 'completed'),
      ),
    )
    .all();

  // Resolve merge order from proposals.sortOrder
  const childRunIds = resolveChildMergeOrder(db, parallelGroupId, completedChildren);

  // Initialize metadata if no journal exists
  const metadata = journal
    ? JSON.parse(journal.metadata ?? '{}')
    : {
        consolidationBranch: `vibe-harness/consolidate-${parentRunId.slice(0, 8)}`,
        mergeOrder: childRunIds,
        mergedChildren: [] as string[],
        conflictChild: null as string | null,
      };

  // Create journal entry if new
  if (!journal) {
    const journalId = crypto.randomUUID();
    db.insert(schema.gitOperations)
      .values({
        id: journalId,
        type: 'consolidate',
        workflowRunId: parentRunId,
        parallelGroupId,
        phase: 'snapshot_parent',
        metadata: JSON.stringify(metadata),
      })
      .run();
    journal = {
      id: journalId,
      phase: 'snapshot_parent',
      metadata: JSON.stringify(metadata),
    } as NonNullable<typeof journal>;
  }

  // ── Phase: snapshot_parent ────────────────────────────────────────
  if (journal.phase === 'snapshot_parent') {
    // Commit any dirty state and create consolidation branch from parent HEAD
    await deps.worktreeService.commitAll(
      projectPath,
      parentRun.worktreePath,
      'Snapshot before consolidation',
    );

    // Create the consolidation branch from parent HEAD.
    // Children merge into this branch, keeping the parent branch clean
    // until the consolidation review is approved.
    await deps.worktreeService.checkoutNewBranch(
      projectPath,
      parentRun.worktreePath,
      metadata.consolidationBranch,
    );

    advancePhase(db, journal.id, 'merge_children', metadata);
  }

  // ── Phase: merge_children (SAD §5.5.3) ────────────────────────────
  const currentPhase = db
    .select({ phase: schema.gitOperations.phase })
    .from(schema.gitOperations)
    .where(eq(schema.gitOperations.id, journal.id))
    .get();

  if (currentPhase?.phase === 'merge_children') {
    for (const childRunId of metadata.mergeOrder) {
      if ((metadata.mergedChildren as string[]).includes(childRunId)) {
        continue; // Already merged in a prior attempt
      }

      const childRun = db
        .select({ branch: schema.workflowRuns.branch })
        .from(schema.workflowRuns)
        .where(eq(schema.workflowRuns.id, childRunId))
        .get();

      if (!childRun?.branch) continue;

      // Fix #5: If retrying after a resolved conflict, the child's branch
      // may already be integrated into the current HEAD. Skip it.
      const alreadyMerged = await deps.worktreeService.isAncestor(parentRun.worktreePath, childRun.branch);
      if (alreadyMerged) {
        (metadata.mergedChildren as string[]).push(childRunId);
        advancePhase(db, journal.id, 'merge_children', metadata);
        continue;
      }

      const mergeResult = await deps.worktreeService.mergeBranch(
        projectPath,
        parentRun.worktreePath,
        childRun.branch,
        metadata.consolidationBranch,
        { noFf: true },
      );

      if (!mergeResult.success) {
        log.warn({ childRunId, branch: childRun.branch }, 'Merge conflict');
        metadata.conflictChild = childRunId;
        advancePhase(db, journal.id, 'merge_children', metadata);

        return { conflict: true, conflictChildId: childRunId };
      }

      (metadata.mergedChildren as string[]).push(childRunId);
      advancePhase(db, journal.id, 'merge_children', metadata);
    }

    // Fix #5: Advance to 'merged' phase — NOT ff_parent.
    advancePhase(db, journal.id, 'merged', metadata);
  }

  // ── Collect merge summary for the consolidation review (Fix #14) ──
  let mergedFiles: string | undefined;
  try {
    const diff = await deps.worktreeService.getDiff(parentRun.worktreePath, metadata.consolidationBranch);
    mergedFiles = `${diff.stats.filesChanged} files changed, ${diff.stats.insertions} insertions(+), ${diff.stats.deletions} deletions(-)`;
  } catch {
    // Best-effort — diff summary is optional
  }

  log.info('Consolidation merge completed (awaiting review before ff_parent)');
  return { conflict: false, mergedFiles };
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

function resolveChildMergeOrder(
  db: ReturnType<typeof getDb>,
  parallelGroupId: string,
  completedChildren: { id: string }[],
): string[] {
  // Resolve order from proposals.sortOrder for deterministic merging
  const proposalRecords = db
    .select({
      launchedWorkflowRunId: schema.proposals.launchedWorkflowRunId,
      sortOrder: schema.proposals.sortOrder,
    })
    .from(schema.proposals)
    .where(eq(schema.proposals.parallelGroupId, parallelGroupId))
    .orderBy(asc(schema.proposals.sortOrder))
    .all();

  const completedIds = new Set(completedChildren.map((c) => c.id));
  return proposalRecords
    .map((p) => p.launchedWorkflowRunId)
    .filter((id): id is string => id != null && completedIds.has(id));
}
