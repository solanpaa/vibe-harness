// ---------------------------------------------------------------------------
// Startup Reconciliation (SAD §2.1.3, CDD-workflow §8)
//
// On daemon start, reconciles in-flight state left by a previous crash:
//   1. Enumerate Docker sandboxes (vibe-*)
//   2. Mark running/provisioning workflow runs as stage_failed
//   3. Stop matching sandboxes
//   4. Stop orphaned sandboxes (no matching active run)
//   5. Replay pending hookResumes (outbox pattern)
//   6. Log reconciliation summary
// ---------------------------------------------------------------------------

import { eq, and, inArray } from 'drizzle-orm';
import { resumeHook } from 'workflow/api';
import { getDb } from '../db/index.js';
import * as schema from '../db/schema.js';
import type { SandboxService } from '../services/sandbox.js';
import { logger } from './logger.js';

// ── Hook Resume Outbox Replayer ──────────────────────────────────────

export async function replayPendingHookResumes(): Promise<number> {
  const db = getDb();
  const pending = db.select().from(schema.hookResumes).all();

  if (pending.length === 0) {
    logger.debug('No pending hook resumes to replay');
    return 0;
  }

  logger.info({ count: pending.length }, 'Replaying pending hook resumes');
  let replayed = 0;

  for (const row of pending) {
    try {
      const payload = JSON.parse(row.action);
      await resumeHook(row.hookToken, payload);

      db.delete(schema.hookResumes)
        .where(eq(schema.hookResumes.id, row.id))
        .run();

      logger.info({ hookToken: row.hookToken }, 'Hook resume replayed successfully');
      replayed++;
    } catch (err) {
      logger.warn(
        { err, hookToken: row.hookToken, id: row.id },
        'Failed to replay hook resume, will retry on next startup',
      );
    }
  }

  return replayed;
}

// ── Main reconciliation ──────────────────────────────────────────────

export interface ReconcileResult {
  runsReconciled: number;
  sandboxesStopped: number;
  hooksReplayed: number;
}

export async function reconcileOnStartup(
  sandboxService: SandboxService,
): Promise<ReconcileResult> {
  const log = logger.child({ operation: 'startup-reconcile' });
  log.info('Starting startup reconciliation');

  const db = getDb();
  const now = new Date().toISOString();
  let runsReconciled = 0;
  let sandboxesStopped = 0;

  // Step 1: Enumerate Docker sandboxes
  const liveSandboxes = await sandboxService.list();
  const liveSandboxNames = new Set(liveSandboxes.map((s) => s.name));
  log.info({ count: liveSandboxes.length }, 'Live Docker sandboxes found');

  // Step 2: Query running/provisioning workflow runs
  const activeRuns = db
    .select()
    .from(schema.workflowRuns)
    .where(inArray(schema.workflowRuns.status, ['running', 'provisioning']))
    .all();

  log.info({ count: activeRuns.length }, 'Active workflow runs found in DB');

  // Track which sandbox names are accounted for by active runs
  const accountedSandboxes = new Set<string>();

  // Step 3: For each running/provisioning run
  for (const run of activeRuns) {
    const runLog = log.child({ runId: run.id, status: run.status });

    // Find current running stageExecution (filtered in SQL)
    const runningStage = db
      .select()
      .from(schema.stageExecutions)
      .where(and(
        eq(schema.stageExecutions.workflowRunId, run.id),
        eq(schema.stageExecutions.status, 'running'),
      ))
      .all()[0];

    if (runningStage) {
      // Mark stageExecution as failed
      db.update(schema.stageExecutions)
        .set({
          status: 'failed',
          failureReason: 'daemon_restart',
          completedAt: now,
        })
        .where(eq(schema.stageExecutions.id, runningStage.id))
        .run();

      runLog.info(
        { stageId: runningStage.id, stageName: runningStage.stageName },
        'Marked running stage execution as failed (daemon_restart)',
      );
    }

    // Transition workflowRun to stage_failed
    db.update(schema.workflowRuns)
      .set({ status: 'stage_failed' })
      .where(eq(schema.workflowRuns.id, run.id))
      .run();

    runLog.info('Transitioned workflow run to stage_failed');
    runsReconciled++;

    // Stop matching sandbox if it exists
    const sandboxName = sandboxService.getSandboxName(run.id);
    accountedSandboxes.add(sandboxName);

    if (liveSandboxNames.has(sandboxName)) {
      try {
        await sandboxService.forceStop(sandboxName);
        sandboxesStopped++;
        runLog.info({ sandboxName }, 'Stopped sandbox for reconciled run');
      } catch (err) {
        runLog.warn({ err, sandboxName }, 'Failed to stop sandbox during reconciliation');
      }
    }
  }

  // Step 4: Stop orphaned sandboxes (vibe-* with no matching active run)
  for (const sandbox of liveSandboxes) {
    if (!accountedSandboxes.has(sandbox.name)) {
      log.warn({ sandboxName: sandbox.name }, 'Stopping orphaned sandbox');
      try {
        await sandboxService.forceStop(sandbox.name);
        sandboxesStopped++;
      } catch (err) {
        log.warn({ err, sandboxName: sandbox.name }, 'Failed to stop orphaned sandbox');
      }
    }
  }

  // Step 5: Replay pending hook resumes
  const hooksReplayed = await replayPendingHookResumes();

  // Step 6: Log summary
  const result: ReconcileResult = {
    runsReconciled,
    sandboxesStopped,
    hooksReplayed,
  };

  log.info(result, 'Startup reconciliation complete');
  return result;
}
