/**
 * Idempotent seed: inserts built-in agent definitions and workflow templates
 * if they don't already exist.
 */

import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';

const COPILOT_CLI_AGENT = {
  name: 'Copilot CLI',
  type: 'copilot_cli',
  commandTemplate: 'copilot',
  dockerImage: 'vibe-harness/copilot:latest',
  description: 'GitHub Copilot CLI — built-in default agent',
  supportsStreaming: true,
  supportsContinue: true,
  supportsIntervention: true,
  outputFormat: 'acp',
  isBuiltIn: true,
} as const;

const WORKFLOW_TEMPLATES = [
  {
    name: 'Quick Run',
    description: 'Single-stage execution — run the agent once with no review gate.',
    stages: JSON.stringify([
      {
        name: 'execute',
        type: 'standard',
        promptTemplate: '{{description}}',
        reviewRequired: false,
        autoAdvance: true,
        freshSession: false,
        isFinal: true,
      },
    ]),
    isBuiltIn: true,
  },
  {
    name: 'Plan & Implement',
    description: 'Three stages: plan, implement, then commit the result.',
    stages: JSON.stringify([
      {
        name: 'plan',
        type: 'standard',
        promptTemplate:
          'Analyze the following task and create a detailed implementation plan. Do NOT write code yet.\n\n{{description}}',
        reviewRequired: true,
        autoAdvance: false,
        freshSession: false,
      },
      {
        name: 'implement',
        type: 'standard',
        promptTemplate:
          'Implement the plan from the previous stage. Write all necessary code changes.\n\n{{description}}',
        reviewRequired: true,
        autoAdvance: false,
        freshSession: false,
      },
      {
        name: 'commit',
        type: 'standard',
        promptTemplate:
          'Commit all changes with a clear, conventional commit message summarizing what was done.',
        reviewRequired: false,
        autoAdvance: true,
        freshSession: false,
        isFinal: true,
      },
    ]),
    isBuiltIn: true,
  },
  {
    name: 'Full Review',
    description:
      'Five stages: plan, implement, review, fix, and commit (SRD FR-W11).',
    stages: JSON.stringify([
      {
        name: 'plan',
        type: 'standard',
        promptTemplate:
          'Analyze the task and produce a detailed plan including architecture decisions.\n\n{{description}}',
        reviewRequired: true,
        autoAdvance: false,
        freshSession: false,
      },
      {
        name: 'implement',
        type: 'standard',
        promptTemplate:
          'Implement all code changes according to the approved plan.\n\n{{description}}',
        reviewRequired: true,
        autoAdvance: false,
        freshSession: false,
      },
      {
        name: 'review',
        type: 'standard',
        promptTemplate:
          'Perform a thorough code review. Check correctness, edge cases, security, and style.',
        reviewRequired: true,
        autoAdvance: false,
        freshSession: true,
      },
      {
        name: 'fix',
        type: 'standard',
        promptTemplate:
          'Address all review comments and fix any identified issues.',
        reviewRequired: true,
        autoAdvance: false,
        freshSession: false,
      },
      {
        name: 'commit',
        type: 'standard',
        promptTemplate:
          'Commit all changes with a clear, conventional commit message summarizing what was done.',
        reviewRequired: false,
        autoAdvance: true,
        freshSession: false,
        isFinal: true,
      },
    ]),
    isBuiltIn: true,
  },
] as const;

export function seed(db: BetterSQLite3Database<typeof schema>) {
  // ── Agent definitions ───────────────────────────────────────────────
  const existingAgent = db
    .select()
    .from(schema.agentDefinitions)
    .where(eq(schema.agentDefinitions.name, COPILOT_CLI_AGENT.name))
    .get();

  if (!existingAgent) {
    db.insert(schema.agentDefinitions).values(COPILOT_CLI_AGENT).run();
  }

  // ── Workflow templates ──────────────────────────────────────────────
  for (const tmpl of WORKFLOW_TEMPLATES) {
    const existing = db
      .select()
      .from(schema.workflowTemplates)
      .where(eq(schema.workflowTemplates.name, tmpl.name))
      .get();

    if (!existing) {
      db.insert(schema.workflowTemplates).values(tmpl).run();
    }
  }
}
