// ---------------------------------------------------------------------------
// Prompt Builder (CDD-workflow §5)
//
// Constructs prompts for the various scenarios encountered during workflow
// execution: standard, freshSession, request_changes, retry.
// ---------------------------------------------------------------------------

import type { ReviewComment } from '../workflows/hooks.js';

export interface StagePromptInput {
  runDescription: string;
  stage: {
    name: string;
    type: 'standard' | 'split';
    promptTemplate: string;
    freshSession: boolean;
  };
  round: number;
  retryError: string | null;
  requestChangesComments: ReviewComment[] | null;
  freshSessionContext: string | null;
}

/**
 * Build the prompt sent to the agent for a given stage + round.
 *
 * Structure follows SAD §5.3 step 4 and SRD FR-W8:
 * - Run description + stage template instructions
 * - For freshSession: prior-stage context
 * - For request_changes: bundled review comments (Fix #2: single message)
 * - For retry: failure-aware message (FR-W14)
 */
export function buildStagePrompt(input: StagePromptInput): string {
  const {
    runDescription,
    stage,
    round,
    retryError,
    requestChangesComments,
    freshSessionContext,
  } = input;

  // request_changes with bundled comments (SAD §5.3.1, Fix #2)
  if (requestChangesComments && requestChangesComments.length > 0) {
    return formatRequestChangesPrompt(runDescription, stage, round, requestChangesComments);
  }

  // Retry after failure (SAD §5.3.2, FR-W14)
  if (retryError) {
    return formatRetryPrompt(runDescription, stage, retryError);
  }

  // freshSession with context injection (SAD §5.4, FR-W8)
  if (stage.freshSession && round === 1 && freshSessionContext) {
    return formatFreshSessionPrompt(runDescription, stage, freshSessionContext);
  }

  // Standard prompt
  return formatStandardPrompt(runDescription, stage);
}

// --- Format helpers ------------------------------------------------------ //

/** Interpolate template variables like {{description}} in stage prompts. */
function interpolate(template: string, runDescription: string): string {
  return template.replace(/\{\{description\}\}/g, runDescription);
}

function formatStandardPrompt(
  runDescription: string,
  stage: { name: string; promptTemplate: string },
): string {
  const stagePrompt = interpolate(stage.promptTemplate, runDescription);
  return [
    '## Task',
    '',
    runDescription,
    '',
    `## Current Stage: ${stage.name}`,
    '',
    stagePrompt,
  ].join('\n');
}

function formatFreshSessionPrompt(
  runDescription: string,
  stage: { name: string; promptTemplate: string },
  freshContext: string,
): string {
  return [
    '## Task',
    '',
    runDescription,
    '',
    '## Context from Prior Stages',
    '',
    'The following is context from completed stages in this workflow.',
    'Use this information to continue the work without re-doing completed steps.',
    '',
    freshContext,
    '',
    `## Current Stage: ${stage.name}`,
    '',
    interpolate(stage.promptTemplate, runDescription),
  ].join('\n');
}

function formatRetryPrompt(
  runDescription: string,
  stage: { name: string; promptTemplate: string },
  error: string,
): string {
  return [
    '## Retry Required',
    '',
    'The previous attempt at this stage failed with the following error:',
    '',
    '```',
    error,
    '```',
    '',
    'Please retry the following stage, avoiding the issue described above.',
    '',
    '## Task',
    '',
    runDescription,
    '',
    `## Current Stage: ${stage.name}`,
    '',
    interpolate(stage.promptTemplate, runDescription),
  ].join('\n');
}

function formatRequestChangesPrompt(
  runDescription: string,
  stage: { name: string; promptTemplate: string },
  round: number,
  comments: ReviewComment[],
): string {
  const commentBlock = formatReviewComments(comments);

  return [
    `## Review Feedback — Changes Requested (Round ${round})`,
    '',
    'The reviewer has requested changes. Please address ALL of the following:',
    '',
    commentBlock,
    '',
    '## Task',
    '',
    runDescription,
    '',
    `## Current Stage: ${stage.name}`,
    '',
    interpolate(stage.promptTemplate, runDescription),
  ].join('\n');
}

/**
 * Format review comments as markdown for embedding in prompts (Fix #2).
 */
function formatReviewComments(comments: ReviewComment[]): string {
  const parts: string[] = [];

  const generalComments = comments.filter((c) => !c.filePath);
  const fileComments = comments.filter((c) => c.filePath);

  if (generalComments.length > 0) {
    parts.push('### General Comments\n');
    for (const c of generalComments) {
      parts.push(`- ${c.body}`);
    }
    parts.push('');
  }

  if (fileComments.length > 0) {
    const byFile = new Map<string, ReviewComment[]>();
    for (const c of fileComments) {
      const existing = byFile.get(c.filePath!) ?? [];
      existing.push(c);
      byFile.set(c.filePath!, existing);
    }

    parts.push('### File-Specific Comments\n');
    for (const [filePath, fileComms] of byFile) {
      parts.push(`**\`${filePath}\`**`);
      for (const c of fileComms) {
        const lineRef = c.lineNumber ? ` (line ${c.lineNumber})` : '';
        parts.push(`-${lineRef}${lineRef ? ' ' : ''} ${c.body}`);
      }
      parts.push('');
    }
  }

  return parts.join('\n');
}
