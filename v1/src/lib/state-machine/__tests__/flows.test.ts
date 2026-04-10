/**
 * Integration flow tests — verify multi-step transition sequences
 * through the state machines using applyTransition with in-memory stores.
 *
 * These test the machine logic end-to-end (guards, actions, transitions)
 * without needing a real SQLite database. DB wiring is tested separately
 * in wiring.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { applyTransition } from '../engine';
import { taskMachine } from '../machines/task';
import { workflowRunMachine } from '../machines/workflow-run';
import type { TaskEvent, WorkflowRunEvent, TransitionResult } from '../types';

// ---------------------------------------------------------------------------
// In-memory state stores
// ---------------------------------------------------------------------------

type StateEntry<T> = { status: string; context: T };

/** Creates a task transition function backed by an in-memory store. */
function createTaskRunner() {
  const store = new Map<string, StateEntry<Record<string, unknown>>>();

  return {
    store,
    init(id: string, ctx?: Partial<{ taskId: string; workflowRunId: string; originTaskId: string | null }>) {
      store.set(id, {
        status: 'pending',
        context: { taskId: id, workflowRunId: '', originTaskId: null, ...ctx } as unknown as Record<string, unknown>,
      });
    },
    async send(id: string, event: TaskEvent): Promise<TransitionResult> {
      const entry = store.get(id);
      if (!entry) throw new Error(`Task ${id} not in store`);
      const noopHandlers: Record<string, () => void> = {};
      for (const key of ['saveOutput', 'setCompletedAt', 'setSandboxId', 'notifyWorkflow']) {
        noopHandlers[key] = () => {};
      }
      const result = await applyTransition<Record<string, unknown>, TaskEvent>({
        machine: taskMachine,
        entityId: id,
        event,
        readState: () => entry,
        writeState: (_id, newStatus) => {
          store.set(id, { ...entry, status: newStatus });
        },
        actionHandlers: noopHandlers,
      });
      // Update the entry reference for next call
      if (result.ok) {
        const updated = store.get(id)!;
        store.set(id, { ...updated });
      }
      return result;
    },
    getStatus(id: string) {
      return store.get(id)?.status;
    },
  };
}

/** Creates a workflow run transition function backed by an in-memory store. */
function createWorkflowRunner() {
  const store = new Map<string, StateEntry<Record<string, unknown>>>();
  // Mutable guard overrides per entity — tests update these between transitions
  const guardOverrides = new Map<string, {
    isLastStage?: boolean;
    isSplitStage?: boolean;
    autoAdvance?: boolean;
    allChildrenDone?: boolean;
  }>();

  const noopActions: Record<string, () => void> = {};
  const actionNames = [
    'setCurrentStage', 'setCompletedAt', 'createReview', 'createMergeConflictReview',
    'createConsolidationReview', 'setReviewApproved', 'setReviewChangesRequested',
    'advanceToNextStage', 'launchNextStageTask', 'launchSplitTask', 'spawnRerunTask',
    'rerunSplitStage', 'createParallelGroup', 'launchChildWorkflows',
    'setParallelGroupCompleted', 'setParallelGroupFailed', 'pauseCurrentTask',
    'resumeCurrentTask', 'cancelCurrentTask', 'cancelChildWorkflows',
    'cleanupSandboxes',
  ];
  for (const name of actionNames) noopActions[name] = () => {};

  return {
    store,
    guardOverrides,
    init(id: string, overrides?: { isLastStage?: boolean; isSplitStage?: boolean; autoAdvance?: boolean }) {
      store.set(id, {
        status: 'pending',
        context: {
          workflowRunId: id,
          workflowTemplateId: 'tpl-1',
          projectId: 'proj-1',
          currentStage: 'plan',
          currentStageName: 'plan',
          currentTaskId: null,
          taskDescription: 'test',
          acpSessionId: null,
          autoAdvance: false,
          isLastStage: false,
          allChildrenDone: false,
          ...overrides,
        } as unknown as Record<string, unknown>,
      });
      if (overrides) guardOverrides.set(id, overrides);
    },
    setGuards(id: string, guards: { isLastStage?: boolean; isSplitStage?: boolean; autoAdvance?: boolean; allChildrenDone?: boolean }) {
      guardOverrides.set(id, { ...guardOverrides.get(id), ...guards });
    },
    async send(id: string, event: WorkflowRunEvent): Promise<TransitionResult> {
      const entry = store.get(id);
      if (!entry) throw new Error(`Workflow ${id} not in store`);

      // Apply guard overrides to context before transition
      const overrides = guardOverrides.get(id) || {};
      const ctx = { ...entry.context, ...overrides } as Record<string, unknown>;
      // Update isSplitStage based on currentStageName
      if ('currentStageName' in ctx && ctx.currentStageName === 'split') {
        ctx.isSplitStage = true;
      }

      const readEntry = { status: entry.status, context: ctx };

      const result = await applyTransition<Record<string, unknown>, WorkflowRunEvent>({
        machine: workflowRunMachine,
        entityId: id,
        event,
        readState: () => readEntry,
        writeState: (_id, newStatus) => {
          store.set(id, { status: newStatus, context: ctx });
        },
        actionHandlers: noopActions,
      });
      return result;
    },
    getStatus(id: string) {
      return store.get(id)?.status;
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function expectOk(result: TransitionResult, from: string, to: string) {
  expect(result).toEqual(expect.objectContaining({ ok: true, from, to }));
}

// ═══════════════════════════════════════════════════════════════════════════
// Task flows
// ═══════════════════════════════════════════════════════════════════════════
describe('Task flows', () => {
  describe('simple task lifecycle', () => {
    it('progresses through pending → provisioning → running → completed', async () => {
      const runner = createTaskRunner();
      runner.init('t1');

      const r1 = await runner.send('t1', { type: 'PROVISION' });
      expectOk(r1, 'pending', 'provisioning');

      const r2 = await runner.send('t1', { type: 'START' });
      expectOk(r2, 'provisioning', 'running');

      const r3 = await runner.send('t1', { type: 'COMPLETE' });
      expectOk(r3, 'running', 'completed');
    });
  });

  describe('cancellation', () => {
    it('cancels a running task', async () => {
      const runner = createTaskRunner();
      runner.init('t1');

      await runner.send('t1', { type: 'PROVISION' });
      await runner.send('t1', { type: 'START' });

      const result = await runner.send('t1', { type: 'CANCEL' });
      expectOk(result, 'running', 'cancelled');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Workflow-run flows
// ═══════════════════════════════════════════════════════════════════════════
describe('Workflow-run flows', () => {
  describe('simple end-to-end (1-stage workflow)', () => {
    it('START → task completes → review → approve → finalize', async () => {
      const wf = createWorkflowRunner();
      wf.init('wf1', { isLastStage: true });

      const r0 = await wf.send('wf1', { type: 'START' });
      expectOk(r0, 'pending', 'running');

      const r1 = await wf.send('wf1', { type: 'TASK_COMPLETED' });
      expectOk(r1, 'running', 'awaiting_review');

      // Last stage → finalizing
      const r2 = await wf.send('wf1', { type: 'APPROVE' });
      expectOk(r2, 'awaiting_review', 'finalizing');

      const r3 = await wf.send('wf1', { type: 'FINALIZE' });
      expectOk(r3, 'finalizing', 'completed');
    });
  });

  describe('multi-stage workflow', () => {
    it('advances through stages: plan → approve → implement → approve → finalize', async () => {
      const wf = createWorkflowRunner();
      wf.init('wf1', { isLastStage: false });

      await wf.send('wf1', { type: 'START' });

      // Stage 1 task completes → review
      const r1 = await wf.send('wf1', { type: 'TASK_COMPLETED' });
      expectOk(r1, 'running', 'awaiting_review');

      // Approve non-final stage → back to running (launches next stage)
      const r2 = await wf.send('wf1', { type: 'APPROVE' });
      expectOk(r2, 'awaiting_review', 'running');

      // Stage 2 task completes → review
      const r3 = await wf.send('wf1', { type: 'TASK_COMPLETED' });
      expectOk(r3, 'running', 'awaiting_review');

      // Now it's the last stage
      wf.setGuards('wf1', { isLastStage: true });

      // Approve final stage → finalize
      const r4 = await wf.send('wf1', { type: 'APPROVE' });
      expectOk(r4, 'awaiting_review', 'finalizing');

      const r5 = await wf.send('wf1', { type: 'FINALIZE' });
      expectOk(r5, 'finalizing', 'completed');
    });
  });

  describe('request-changes loop', () => {
    it('reruns the same stage then approves', async () => {
      const wf = createWorkflowRunner();
      wf.init('wf1', { isLastStage: true });

      await wf.send('wf1', { type: 'START' });

      // Task completes → review
      await wf.send('wf1', { type: 'TASK_COMPLETED' });

      // Request changes → back to running
      const r1 = await wf.send('wf1', { type: 'REQUEST_CHANGES' });
      expectOk(r1, 'awaiting_review', 'running');

      // Rerun task completes → review again
      const r2 = await wf.send('wf1', { type: 'TASK_COMPLETED' });
      expectOk(r2, 'running', 'awaiting_review');

      // Now approve
      const r3 = await wf.send('wf1', { type: 'APPROVE' });
      expectOk(r3, 'awaiting_review', 'finalizing');
    });
  });

  describe('split flow', () => {
    it('split → run split task → proposals → launch → consolidate', async () => {
      const wf = createWorkflowRunner();
      wf.init('wf1', { isLastStage: false });

      await wf.send('wf1', { type: 'START' });

      // Plan task completes → review
      await wf.send('wf1', { type: 'TASK_COMPLETED' });

      // User chooses "split" → goes back to running (to run split agent)
      const r1 = await wf.send('wf1', { type: 'SPLIT' });
      expectOk(r1, 'awaiting_review', 'running');

      // Now the split task is running — set isSplitStage guard
      wf.setGuards('wf1', { isSplitStage: true });
      // Also update context so the guard reads correctly
      const entry = wf.store.get('wf1')!;
      entry.context = { ...entry.context, currentStageName: 'split' };

      // Split task completes → awaiting_split_review (isSplitStage guard)
      const r2 = await wf.send('wf1', { type: 'TASK_COMPLETED' });
      expectOk(r2, 'running', 'awaiting_split_review');

      // User launches proposals → running_parallel
      const r3 = await wf.send('wf1', { type: 'LAUNCH_PROPOSALS' });
      expectOk(r3, 'awaiting_split_review', 'running_parallel');

      // All children done → consolidate → awaiting_review (consolidation review)
      wf.setGuards('wf1', { allChildrenDone: true, isLastStage: true });
      const r4 = await wf.send('wf1', { type: 'CONSOLIDATE' });
      expectOk(r4, 'running_parallel', 'awaiting_review');

      // Approve consolidation review → finalizing
      const r5 = await wf.send('wf1', { type: 'APPROVE' });
      expectOk(r5, 'awaiting_review', 'finalizing');

      // Finalize → completed
      const r6 = await wf.send('wf1', { type: 'FINALIZE' });
      expectOk(r6, 'finalizing', 'completed');
    });
  });

  describe('merge conflict during finalization', () => {
    it('conflict → review → resolve → approve → finalize', async () => {
      const wf = createWorkflowRunner();
      wf.init('wf1', { isLastStage: true });

      await wf.send('wf1', { type: 'START' });

      // Reach finalizing
      await wf.send('wf1', { type: 'TASK_COMPLETED' });
      await wf.send('wf1', { type: 'APPROVE' });
      expect(wf.getStatus('wf1')).toBe('finalizing');

      // Merge fails → back to review
      const r1 = await wf.send('wf1', { type: 'MERGE_CONFLICT' });
      expectOk(r1, 'finalizing', 'awaiting_review');

      // Resolve and re-approve
      const r2 = await wf.send('wf1', { type: 'APPROVE' });
      expectOk(r2, 'awaiting_review', 'finalizing');

      // Finalize succeeds
      const r3 = await wf.send('wf1', { type: 'FINALIZE' });
      expectOk(r3, 'finalizing', 'completed');
    });
  });

  describe('cancellation', () => {
    it('cancels a running workflow', async () => {
      const wf = createWorkflowRunner();
      wf.init('wf1');

      await wf.send('wf1', { type: 'START' });

      const result = await wf.send('wf1', { type: 'CANCEL' });
      expectOk(result, 'running', 'cancelled');
    });
  });

  describe('pause race condition', () => {
    it('task completes while workflow is paused — workflow handles it', async () => {
      const wf = createWorkflowRunner();
      wf.init('wf1');

      await wf.send('wf1', { type: 'START' });

      // Pause the workflow
      const r1 = await wf.send('wf1', { type: 'PAUSE' });
      expectOk(r1, 'running', 'paused');

      // Task completes anyway (agent finished before pause propagated)
      const r2 = await wf.send('wf1', { type: 'TASK_COMPLETED' });
      expectOk(r2, 'paused', 'awaiting_review');
    });
  });
});
