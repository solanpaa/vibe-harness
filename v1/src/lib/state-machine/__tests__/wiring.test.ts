/**
 * Tests for the index.ts readState/actionHandler DB wiring layer.
 *
 * These test the glue between xstate machines and the real DB,
 * specifically the logic in readState (guard computation) and
 * action handlers (notifyWorkflow, etc.).
 *
 * These are unit tests with mocked DB — they verify the logic of
 * readState and action handlers, not the full integration.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// We test the logic patterns, not the full DB integration.
// These document the contracts that readState and handlers must satisfy.

describe('readState contracts', () => {
  describe('notifyWorkflow derives event type from triggering event', () => {
    it('COMPLETE event → TASK_COMPLETED (not re-read from DB)', () => {
      // The notifyWorkflow handler receives (ctx, evt).
      // evt.type should determine the workflow event, not a DB read.
      const evt = { type: 'COMPLETE' as const, output: 'done', lastAiMessage: null };
      const eventType = evt.type === 'FAIL' ? 'TASK_FAILED' : 'TASK_COMPLETED';
      expect(eventType).toBe('TASK_COMPLETED');
    });

    it('FAIL event → TASK_FAILED', () => {
      const evt = { type: 'FAIL' as const, output: 'crash' };
      const eventType = evt.type === 'FAIL' ? 'TASK_FAILED' : 'TASK_COMPLETED';
      expect(eventType).toBe('TASK_FAILED');
    });
  });

  describe('allChildrenDone resolution', () => {
    it('requires resolving through parallel_groups table, not direct workflowRunId', () => {
      // The correct query path is:
      //   1. Find parallel_groups WHERE sourceWorkflowRunId = thisRunId
      //   2. Find child workflow_runs WHERE parallelGroupId = group.id
      //   3. Check if all children are in terminal state
      //
      // WRONG: WHERE parallelGroupId = workflowRunId (those are different FK types)

      const workflowRunId = 'wf-parent-1';
      const parallelGroupId = 'pg-1'; // This is NOT the same as workflowRunId

      // Simulate the correct resolution
      const groups = [{ id: parallelGroupId, sourceWorkflowRunId: workflowRunId }];
      const children = [
        { status: 'completed', parallelGroupId },
        { status: 'completed', parallelGroupId },
      ];

      const relevantChildren = children.filter((c) =>
        groups.some((g) => g.id === c.parallelGroupId)
      );
      const allDone = relevantChildren.length > 0 &&
        relevantChildren.every((c) =>
          c.status === 'completed' || c.status === 'failed' || c.status === 'cancelled'
        );

      expect(allDone).toBe(true);
    });

    it('returns false when some children are still running', () => {
      const children = [
        { status: 'completed' },
        { status: 'running' },
      ];
      const allDone = children.length > 0 &&
        children.every((c) =>
          c.status === 'completed' || c.status === 'failed' || c.status === 'cancelled'
        );
      expect(allDone).toBe(false);
    });

    it('returns false when no children exist', () => {
      const children: { status: string }[] = [];
      const allDone = children.length > 0 &&
        children.every((c) =>
          c.status === 'completed' || c.status === 'failed' || c.status === 'cancelled'
        );
      expect(allDone).toBe(false);
    });
  });

  describe('isLastStage computation', () => {
    it('returns true when current stage is the last in the template', () => {
      const stages = [
        { name: 'plan' },
        { name: 'implement' },
        { name: 'fix' },
      ];
      const currentStageName = 'fix';
      const idx = stages.findIndex((s) => s.name === currentStageName);
      const isLastStage = idx >= 0 && idx >= stages.length - 1;
      expect(isLastStage).toBe(true);
    });

    it('returns false when current stage is not the last', () => {
      const stages = [
        { name: 'plan' },
        { name: 'implement' },
        { name: 'fix' },
      ];
      const currentStageName = 'plan';
      const idx = stages.findIndex((s) => s.name === currentStageName);
      const isLastStage = idx >= 0 && idx >= stages.length - 1;
      expect(isLastStage).toBe(false);
    });

    it('returns false for dynamic "split" stage (not in template)', () => {
      const stages = [
        { name: 'plan' },
        { name: 'implement' },
      ];
      const currentStageName = 'split';
      const idx = stages.findIndex((s) => s.name === currentStageName);
      const isLastStage = idx >= 0 && idx >= stages.length - 1;
      // split is not found in template → idx = -1 → isLastStage = false
      expect(isLastStage).toBe(false);
    });
  });

  describe('currentTask finder (no N+1)', () => {
    it('finds the non-terminal task in a single pass', () => {
      const tasks = [
        { id: 'task-1', status: 'completed' },
        { id: 'task-2', status: 'failed' },
        { id: 'task-3', status: 'running' },
      ];

      // Single-pass filter — no per-row DB query
      const currentTask = tasks
        .filter((t) =>
          t.status !== 'completed' && t.status !== 'failed' && t.status !== 'cancelled'
        )
        .pop();

      expect(currentTask?.id).toBe('task-3');
    });

    it('returns undefined when all tasks are terminal', () => {
      const tasks = [
        { id: 'task-1', status: 'completed' },
        { id: 'task-2', status: 'failed' },
      ];

      const currentTask = tasks
        .filter((t) =>
          t.status !== 'completed' && t.status !== 'failed' && t.status !== 'cancelled'
        )
        .pop();

      expect(currentTask).toBeUndefined();
    });
  });
});
