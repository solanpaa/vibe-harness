import { describe, it, expect } from 'vitest';
import { buildStagePrompt, type StagePromptInput } from '../../src/services/prompt-builder.js';

// ── Helpers ──────────────────────────────────────────────────────────

function makeInput(overrides: Partial<StagePromptInput> = {}): StagePromptInput {
  return {
    runDescription: 'Add user authentication',
    stage: {
      name: 'implement',

      promptTemplate: 'Implement the plan.',
      freshSession: false,
    },
    round: 1,
    retryError: null,
    requestChangesComments: null,
    freshSessionContext: null,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('buildStagePrompt', () => {
  describe('standard prompt', () => {
    it('includes run description and stage template', () => {
      const prompt = buildStagePrompt(makeInput());
      expect(prompt).toContain('## Task');
      expect(prompt).toContain('Add user authentication');
      expect(prompt).toContain('## Current Stage: implement');
      expect(prompt).toContain('Implement the plan.');
    });

    it('uses stage name in header', () => {
      const prompt = buildStagePrompt(
        makeInput({ stage: { name: 'plan', promptTemplate: 'Create a plan.', freshSession: false } }),
      );
      expect(prompt).toContain('## Current Stage: plan');
    });
  });

  describe('freshSession prompt', () => {
    it('includes context from prior stages when freshSession + round 1 + context present', () => {
      const prompt = buildStagePrompt(
        makeInput({
          stage: { name: 'review', promptTemplate: 'Review code.', freshSession: true },
          freshSessionContext: 'Stage "plan" completed with summary...',
        }),
      );
      expect(prompt).toContain('## Context from Prior Stages');
      expect(prompt).toContain('Stage "plan" completed with summary...');
      expect(prompt).toContain('## Current Stage: review');
      expect(prompt).toContain('## Task');
    });

    it('falls back to standard prompt if freshSession but no context', () => {
      const prompt = buildStagePrompt(
        makeInput({
          stage: { name: 'review', promptTemplate: 'Review code.', freshSession: true },
          freshSessionContext: null,
        }),
      );
      expect(prompt).not.toContain('Context from Prior Stages');
      expect(prompt).toContain('## Task');
      expect(prompt).toContain('## Current Stage: review');
    });

    it('falls back to standard prompt if freshSession but round > 1', () => {
      const prompt = buildStagePrompt(
        makeInput({
          stage: { name: 'review', promptTemplate: 'Review code.', freshSession: true },
          round: 2,
          freshSessionContext: 'Some context',
        }),
      );
      // round > 1 means it's a re-execution, not the initial fresh session
      expect(prompt).not.toContain('Context from Prior Stages');
    });
  });

  describe('request-changes prompt', () => {
    it('bundles review comments into a single prompt (Fix #2)', () => {
      const prompt = buildStagePrompt(
        makeInput({
          round: 2,
          requestChangesComments: [
            { body: 'Fix the login logic', filePath: 'src/auth.ts', lineNumber: 42 },
            { body: 'Add error handling', filePath: 'src/auth.ts', lineNumber: 99 },
            { body: 'General: improve test coverage', filePath: null },
          ],
        }),
      );
      expect(prompt).toContain('## Review Feedback — Changes Requested (Round 2)');
      expect(prompt).toContain('Fix the login logic');
      expect(prompt).toContain('Add error handling');
      expect(prompt).toContain('General: improve test coverage');
      // File grouping
      expect(prompt).toContain('`src/auth.ts`');
      // General comments section
      expect(prompt).toContain('### General Comments');
      expect(prompt).toContain('### File-Specific Comments');
    });

    it('includes line number references for file comments', () => {
      const prompt = buildStagePrompt(
        makeInput({
          round: 2,
          requestChangesComments: [
            { body: 'Fix this', filePath: 'src/index.ts', lineNumber: 10 },
          ],
        }),
      );
      expect(prompt).toContain('(line 10)');
    });

    it('request_changes takes priority over retry and freshSession', () => {
      const prompt = buildStagePrompt(
        makeInput({
          round: 2,
          retryError: 'some error',
          requestChangesComments: [{ body: 'Fix this', filePath: null }],
          stage: { name: 'impl', promptTemplate: 'Do it.', freshSession: true },
          freshSessionContext: 'context',
        }),
      );
      expect(prompt).toContain('Changes Requested');
      expect(prompt).not.toContain('Retry Required');
      expect(prompt).not.toContain('Context from Prior Stages');
    });
  });

  describe('retry prompt', () => {
    it('includes failure error info', () => {
      const prompt = buildStagePrompt(
        makeInput({
          retryError: 'Process exited with code 1: timeout',
        }),
      );
      expect(prompt).toContain('## Retry Required');
      expect(prompt).toContain('Process exited with code 1: timeout');
      expect(prompt).toContain('avoiding the issue described above');
      // Still includes task and stage
      expect(prompt).toContain('## Task');
      expect(prompt).toContain('## Current Stage: implement');
    });

    it('retry takes priority over freshSession', () => {
      const prompt = buildStagePrompt(
        makeInput({
          retryError: 'error',
          stage: { name: 'review', promptTemplate: 'Review.', freshSession: true },
          freshSessionContext: 'prior context',
        }),
      );
      expect(prompt).toContain('Retry Required');
      expect(prompt).not.toContain('Context from Prior Stages');
    });
  });

  describe('empty/missing fields handled gracefully', () => {
    it('handles empty run description', () => {
      const prompt = buildStagePrompt(makeInput({ runDescription: '' }));
      expect(prompt).toContain('## Task');
      expect(prompt).toContain('## Current Stage: implement');
    });

    it('handles empty prompt template', () => {
      const prompt = buildStagePrompt(
        makeInput({ stage: { name: 'x', promptTemplate: '', freshSession: false } }),
      );
      expect(prompt).toContain('## Current Stage: x');
    });

    it('handles empty comments array (no request_changes path)', () => {
      const prompt = buildStagePrompt(
        makeInput({ requestChangesComments: [] }),
      );
      // Empty array should not trigger request_changes path
      expect(prompt).not.toContain('Changes Requested');
      expect(prompt).toContain('## Task');
    });
  });
});
