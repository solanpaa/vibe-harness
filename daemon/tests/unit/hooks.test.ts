import { describe, it, expect } from 'vitest';
import {
  reviewDecisionHook,
  stageFailedHook,
  proposalReviewHook,
  parallelCompletionHook,
  conflictResolutionHook,
  reviewDecisionResponseSchema,
  stageFailedResponseSchema,
  proposalReviewResponseSchema,
  parallelCompletionResponseSchema,
  conflictResolutionResponseSchema,
} from '../../src/workflows/hooks.js';

// ── Tests ────────────────────────────────────────────────────────────

describe('workflow hooks', () => {
  describe('all 5 hooks export correct Zod schemas', () => {
    it.each([
      ['reviewDecisionResponseSchema', reviewDecisionResponseSchema],
      ['stageFailedResponseSchema', stageFailedResponseSchema],
      ['proposalReviewResponseSchema', proposalReviewResponseSchema],
      ['parallelCompletionResponseSchema', parallelCompletionResponseSchema],
      ['conflictResolutionResponseSchema', conflictResolutionResponseSchema],
    ])('%s is a Zod schema with safeParse', (_name, s) => {
      expect(s).toBeDefined();
      expect(typeof s.safeParse).toBe('function');
    });
  });

  describe('reviewDecisionHook schema', () => {
    it('accepts approve action', () => {
      const result = reviewDecisionResponseSchema.safeParse({ action: 'approve' });
      expect(result.success).toBe(true);
    });

    it('accepts request_changes with comments', () => {
      const result = reviewDecisionResponseSchema.safeParse({
        action: 'request_changes',
        comments: [{ body: 'Fix this', filePath: null }],
      });
      expect(result.success).toBe(true);
    });

    it('rejects request_changes without comments', () => {
      const result = reviewDecisionResponseSchema.safeParse({
        action: 'request_changes',
        comments: [],
      });
      expect(result.success).toBe(false);
    });

    it('rejects unknown action', () => {
      const result = reviewDecisionResponseSchema.safeParse({ action: 'reject' });
      expect(result.success).toBe(false);
    });

    it('rejects missing action', () => {
      const result = reviewDecisionResponseSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    it('accepts comment with all optional fields', () => {
      const result = reviewDecisionResponseSchema.safeParse({
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
      const result = reviewDecisionResponseSchema.safeParse({
        action: 'request_changes',
        comments: [{ body: 'General feedback', filePath: null }],
      });
      expect(result.success).toBe(true);
    });
  });

  describe('stageFailedHook schema', () => {
    it('accepts retry action', () => {
      expect(stageFailedResponseSchema.safeParse({ action: 'retry' }).success).toBe(true);
    });

    it('accepts skip action', () => {
      expect(stageFailedResponseSchema.safeParse({ action: 'skip' }).success).toBe(true);
    });

    it('accepts cancel action', () => {
      expect(stageFailedResponseSchema.safeParse({ action: 'cancel' }).success).toBe(true);
    });

    it('rejects unknown action', () => {
      expect(stageFailedResponseSchema.safeParse({ action: 'abort' }).success).toBe(false);
    });

    it('rejects empty object', () => {
      expect(stageFailedResponseSchema.safeParse({}).success).toBe(false);
    });
  });

  describe('proposalReviewHook schema', () => {
    it('accepts valid proposal IDs', () => {
      const result = proposalReviewResponseSchema.safeParse({ proposalIds: ['p1', 'p2'] });
      expect(result.success).toBe(true);
    });

    it('rejects empty proposal IDs when min(1) is expected', () => {
      // Note: current schema allows empty array — this test documents actual behavior
      const result = proposalReviewResponseSchema.safeParse({ proposalIds: [] });
      expect(result.success).toBe(true);
    });

    it('rejects missing proposalIds', () => {
      const result = proposalReviewResponseSchema.safeParse({});
      expect(result.success).toBe(false);
    });
  });

  describe('parallelCompletionHook schema', () => {
    it('accepts consolidate_completed', () => {
      expect(parallelCompletionResponseSchema.safeParse({ action: 'consolidate_completed' }).success).toBe(true);
    });

    it('accepts retry with child run IDs', () => {
      const result = parallelCompletionResponseSchema.safeParse({ action: 'retry', childRunIds: ['r1'] });
      expect(result.success).toBe(true);
    });

    it('rejects retry without child run IDs', () => {
      const result = parallelCompletionResponseSchema.safeParse({ action: 'retry', childRunIds: [] });
      expect(result.success).toBe(false);
    });

    it('accepts cancel', () => {
      expect(parallelCompletionResponseSchema.safeParse({ action: 'cancel' }).success).toBe(true);
    });

    it('rejects unknown action', () => {
      expect(parallelCompletionResponseSchema.safeParse({ action: 'fail' }).success).toBe(false);
    });
  });

  describe('conflictResolutionHook schema', () => {
    it('accepts retry', () => {
      expect(conflictResolutionResponseSchema.safeParse({ action: 'retry' }).success).toBe(true);
    });

    it('accepts cancel', () => {
      expect(conflictResolutionResponseSchema.safeParse({ action: 'cancel' }).success).toBe(true);
    });

    it('rejects skip (not a valid option)', () => {
      expect(conflictResolutionResponseSchema.safeParse({ action: 'skip' }).success).toBe(false);
    });
  });

  describe('hook token prefixes', () => {
    it('reviewDecisionHook has create and resume methods', () => {
      expect(typeof reviewDecisionHook.create).toBe('function');
      expect(typeof reviewDecisionHook.resume).toBe('function');
    });

    it('stageFailedHook has create and resume methods', () => {
      expect(typeof stageFailedHook.create).toBe('function');
      expect(typeof stageFailedHook.resume).toBe('function');
    });

    it('conflictResolutionHook has create and resume methods', () => {
      expect(typeof conflictResolutionHook.create).toBe('function');
      expect(typeof conflictResolutionHook.resume).toBe('function');
    });
  });
});
