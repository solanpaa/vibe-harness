import { describe, it, expect } from 'vitest';
import {
  stageFailedToken,
  reviewToken,
  proposalsToken,
  parallelToken,
  finalizeConflictToken,
  consolidateConflictToken,
} from '../../src/workflows/hookTokens.js';

describe('hookTokens', () => {
  it('produces stable, distinct tokens per hook kind', () => {
    expect(stageFailedToken('r1', 'plan')).toBe('failed:r1:plan');
    expect(reviewToken('rev1')).toBe('review:rev1');
    expect(proposalsToken('r1')).toBe('proposals:r1');
    expect(parallelToken('r1')).toBe('parallel:r1');
    expect(finalizeConflictToken('r1')).toBe('conflict:r1:finalize');
    expect(consolidateConflictToken('r1', 'g1')).toBe('conflict:r1:g1:consolidate');
  });

  it('tokens are deterministic (no time/random component)', () => {
    expect(stageFailedToken('r1', 'plan')).toBe(stageFailedToken('r1', 'plan'));
    expect(proposalsToken('r1')).toBe(proposalsToken('r1'));
    expect(consolidateConflictToken('r1', 'g1')).toBe(consolidateConflictToken('r1', 'g1'));
  });

  it('proposals token does NOT include stage name (regression: cancel mismatch)', () => {
    // Pipeline creates `proposals:${runId}`; cancel route previously used
    // `proposals:${runId}:${currentStage}` and silently failed to resume.
    expect(proposalsToken('r1')).toBe('proposals:r1');
    expect(proposalsToken('r1')).not.toContain('plan');
  });

  it('finalize and consolidate conflict tokens are distinct for the same run', () => {
    expect(finalizeConflictToken('r1')).not.toBe(consolidateConflictToken('r1', 'g1'));
  });
});
