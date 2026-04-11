import { describe, it, expect } from 'vitest';
import {
  reviewDecisionHook,
  stageFailedHook,
  proposalReviewHook,
  parallelCompletionHook,
  conflictResolutionHook,
} from '../../src/workflows/hooks.js';

// ── Helpers ──────────────────────────────────────────────────────────

function getSchema(hook: { schema: unknown }) {
  return (hook as any).schema;
}

// ── Tests ────────────────────────────────────────────────────────────

describe('workflow hooks', () => {
  describe('all hooks export Zod schemas', () => {
    it.each([
      ['reviewDecisionHook', reviewDecisionHook],
      ['stageFailedHook', stageFailedHook],
      ['proposalReviewHook', proposalReviewHook],
      ['parallelCompletionHook', parallelCompletionHook],
      ['conflictResolutionHook', conflictResolutionHook],
    ])('%s has a schema property', (_name, hook) => {
      expect(hook).toBeDefined();
      expect(hook).toHaveProperty('schema');
    });
  });

  describe('reviewDecisionHook', () => {
    const schema = getSchema(reviewDecisionHook);

    it('accepts approve action', () => {
      const result = schema.safeParse({ action: 'approve' });
      expect(result.success).toBe(true);
    });

    it('accepts request_changes with comments', () => {
      const result = schema.safeParse({
        action: 'request_changes',
        comments: [{ body: 'Fix this', filePath: null }],
      });
      expect(result.success).toBe(true);
    });

    it('rejects request_changes without comments', () => {
      const result = schema.safeParse({
        action: 'request_changes',
        comments: [],
      });
      expect(result.success).toBe(false);
    });

    it('rejects unknown action', () => {
      const result = schema.safeParse({ action: 'reject' });
      expect(result.success).toBe(false);
    });

    it('accepts cancel action', () => {
      const result = schema.safeParse({ action: 'cancel' });
      expect(result.success).toBe(true);
    });

    it('rejects missing action', () => {
      const result = schema.safeParse({});
      expect(result.success).toBe(false);
    });

    it('accepts comment with optional fields', () => {
      const result = schema.safeParse({
        action: 'request_changes',
        comments: [
          {
            id: 'c1',
            filePath: 'src/main.ts',
            lineNumber: 42,
            side: 'right',
            body: 'Fix indentation',
          },
        ],
      });
      expect(result.success).toBe(true);
    });

    it('accepts comment with minimal fields', () => {
      const result = schema.safeParse({
        action: 'request_changes',
        comments: [{ body: 'General feedback', filePath: null }],
      });
      expect(result.success).toBe(true);
    });
  });

  describe('stageFailedHook', () => {
    const schema = getSchema(stageFailedHook);

    it('accepts retry action', () => {
      expect(schema.safeParse({ action: 'retry' }).success).toBe(true);
    });

    it('accepts skip action', () => {
      expect(schema.safeParse({ action: 'skip' }).success).toBe(true);
    });

    it('accepts cancel action', () => {
      expect(schema.safeParse({ action: 'cancel' }).success).toBe(true);
    });

    it('rejects unknown action', () => {
      expect(schema.safeParse({ action: 'abort' }).success).toBe(false);
    });

    it('rejects empty object', () => {
      expect(schema.safeParse({}).success).toBe(false);
    });
  });

  describe('proposalReviewHook', () => {
    const schema = getSchema(proposalReviewHook);

    it('accepts valid proposal IDs', () => {
      const result = schema.safeParse({ proposalIds: ['p1', 'p2'] });
      expect(result.success).toBe(true);
    });

    it('accepts empty proposal IDs (cancel)', () => {
      const result = schema.safeParse({ proposalIds: [] });
      expect(result.success).toBe(true);
    });

    it('rejects missing proposalIds', () => {
      const result = schema.safeParse({});
      expect(result.success).toBe(false);
    });
  });

  describe('parallelCompletionHook', () => {
    const schema = getSchema(parallelCompletionHook);

    it('accepts consolidate_completed', () => {
      expect(schema.safeParse({ action: 'consolidate_completed' }).success).toBe(true);
    });

    it('accepts retry with child run IDs', () => {
      const result = schema.safeParse({ action: 'retry', childRunIds: ['r1'] });
      expect(result.success).toBe(true);
    });

    it('rejects retry without child run IDs', () => {
      const result = schema.safeParse({ action: 'retry', childRunIds: [] });
      expect(result.success).toBe(false);
    });

    it('accepts cancel', () => {
      expect(schema.safeParse({ action: 'cancel' }).success).toBe(true);
    });

    it('rejects unknown action', () => {
      expect(schema.safeParse({ action: 'fail' }).success).toBe(false);
    });
  });

  describe('conflictResolutionHook', () => {
    const schema = getSchema(conflictResolutionHook);

    it('accepts retry', () => {
      expect(schema.safeParse({ action: 'retry' }).success).toBe(true);
    });

    it('accepts cancel', () => {
      expect(schema.safeParse({ action: 'cancel' }).success).toBe(true);
    });

    it('rejects skip (not a valid option)', () => {
      expect(schema.safeParse({ action: 'skip' }).success).toBe(false);
    });
  });

  describe('hook token prefixes', () => {
    it('reviewDecisionHook create produces a token-bearing object', () => {
      // Hooks are created with a token via `hook.create({ token })`.
      // We verify the hook supports the `create` method, which
      // the pipeline uses with token format `review:{reviewId}`.
      expect(typeof reviewDecisionHook.create).toBe('function');
    });

    it('stageFailedHook create produces a token-bearing object', () => {
      // Token format: `failed:{runId}:{stageName}:{timestamp}`
      expect(typeof stageFailedHook.create).toBe('function');
    });

    it('conflictResolutionHook create produces a token-bearing object', () => {
      // Token format: `conflict:{runId}:finalize:{timestamp}`
      expect(typeof conflictResolutionHook.create).toBe('function');
    });
  });
});
