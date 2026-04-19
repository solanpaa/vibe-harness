// ---------------------------------------------------------------------------
// Proposal Service (CDD §11)
//
// CRUD operations for split proposals. Standalone service with no service
// dependencies — reads/writes DB only. (SAD §5.1, SRD §2.5 FR-S1–S4)
// ---------------------------------------------------------------------------

import { eq, and, asc } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { Logger } from 'pino';
import * as schema from '../db/schema.js';
import { AppError } from '../lib/errors.js';

// ── Error classes ────────────────────────────────────────────────────

export class ProposalNotFoundError extends AppError {
  readonly code = 'PROPOSAL_NOT_FOUND';
  readonly httpStatus = 404;
  constructor(proposalId: string) {
    super(`Proposal '${proposalId}' not found`, { proposalId });
  }
}

export class ProposalValidationError extends AppError {
  readonly code = 'PROPOSAL_VALIDATION_ERROR';
  readonly httpStatus = 409;
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details);
  }
}

// ── Types ────────────────────────────────────────────────────────────

export interface ProposalInput {
  workflowRunId: string;
  stageName: string;
  title: string;
  description: string;
  affectedFiles?: string[];
  dependsOn?: string[];
  workflowTemplateOverride?: string;
  sortOrder?: number;
}

export interface ProposalUpdate {
  title?: string;
  description?: string;
  affectedFiles?: string[];
  dependsOn?: string[];
  workflowTemplateOverride?: string | null;
  sortOrder?: number;
  status?: 'proposed' | 'approved' | 'discarded';
}

export interface Proposal {
  id: string;
  workflowRunId: string;
  stageName: string;
  parallelGroupId: string | null;
  title: string;
  description: string;
  affectedFiles: string[];
  dependsOn: string[];
  workflowTemplateOverride: string | null;
  status: string;
  launchedWorkflowRunId: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProposalService {
  createProposal(input: ProposalInput): Proposal;
  listProposals(workflowRunId: string, options?: { stageName?: string; status?: string }): Proposal[];
  getProposal(proposalId: string): Proposal;
  getProposalsByRun(workflowRunId: string): Proposal[];
  getProposalsByParallelGroup(groupId: string): Proposal[];
  updateProposal(proposalId: string, update: ProposalUpdate): Proposal;
  deleteProposal(proposalId: string): void;
  parseProposals(agentOutput: string): ParsedProposal[];
}

export interface ParsedProposal {
  title: string;
  description: string;
  affectedFiles?: string[];
  dependsOn?: string[];
}

// ── Factory ──────────────────────────────────────────────────────────

export function createProposalService(deps: {
  logger: Logger;
  db: BetterSQLite3Database<typeof schema>;
}): ProposalService {
  const { logger, db } = deps;

  function createProposal(input: ProposalInput): Proposal {
    // Idempotent: UNIQUE(workflowRunId, stageName, title)
    const existing = db
      .select()
      .from(schema.proposals)
      .where(
        and(
          eq(schema.proposals.workflowRunId, input.workflowRunId),
          eq(schema.proposals.stageName, input.stageName),
          eq(schema.proposals.title, input.title),
        ),
      )
      .get();

    if (existing) {
      return mapRow(existing);
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    db.insert(schema.proposals)
      .values({
        id,
        workflowRunId: input.workflowRunId,
        stageName: input.stageName,
        parallelGroupId: null,
        title: input.title,
        description: input.description,
        affectedFiles: JSON.stringify(input.affectedFiles ?? []),
        dependsOn: JSON.stringify(input.dependsOn ?? []),
        workflowTemplateOverride: input.workflowTemplateOverride ?? null,
        status: 'proposed',
        launchedWorkflowRunId: null,
        sortOrder: input.sortOrder ?? 0,
      })
      .run();

    return getProposal(id);
  }

  function listProposals(
    workflowRunId: string,
    options?: { stageName?: string; status?: string },
  ): Proposal[] {
    let rows;

    if (options?.stageName && options?.status) {
      rows = db
        .select()
        .from(schema.proposals)
        .where(
          and(
            eq(schema.proposals.workflowRunId, workflowRunId),
            eq(schema.proposals.stageName, options.stageName),
            eq(schema.proposals.status, options.status),
          ),
        )
        .orderBy(asc(schema.proposals.sortOrder))
        .all();
    } else if (options?.stageName) {
      rows = db
        .select()
        .from(schema.proposals)
        .where(
          and(
            eq(schema.proposals.workflowRunId, workflowRunId),
            eq(schema.proposals.stageName, options.stageName),
          ),
        )
        .orderBy(asc(schema.proposals.sortOrder))
        .all();
    } else if (options?.status) {
      rows = db
        .select()
        .from(schema.proposals)
        .where(
          and(
            eq(schema.proposals.workflowRunId, workflowRunId),
            eq(schema.proposals.status, options.status),
          ),
        )
        .orderBy(asc(schema.proposals.sortOrder))
        .all();
    } else {
      rows = db
        .select()
        .from(schema.proposals)
        .where(eq(schema.proposals.workflowRunId, workflowRunId))
        .orderBy(asc(schema.proposals.sortOrder))
        .all();
    }

    return rows.map(mapRow);
  }

  function getProposal(proposalId: string): Proposal {
    const row = db
      .select()
      .from(schema.proposals)
      .where(eq(schema.proposals.id, proposalId))
      .get();

    if (!row) throw new ProposalNotFoundError(proposalId);
    return mapRow(row);
  }

  function getProposalsByRun(workflowRunId: string): Proposal[] {
    return listProposals(workflowRunId);
  }

  function getProposalsByParallelGroup(groupId: string): Proposal[] {
    const rows = db
      .select()
      .from(schema.proposals)
      .where(eq(schema.proposals.parallelGroupId, groupId))
      .orderBy(asc(schema.proposals.sortOrder))
      .all();

    return rows.map(mapRow);
  }

  function updateProposal(proposalId: string, update: ProposalUpdate): Proposal {
    const existing = getProposal(proposalId);

    if (existing.status === 'launched') {
      throw new ProposalValidationError(
        `Cannot update proposal ${proposalId}: already launched`,
        { proposalId, status: existing.status },
      );
    }

    const setFields: Record<string, unknown> = {
      updatedAt: new Date().toISOString(),
    };

    if (update.title !== undefined) setFields.title = update.title;
    if (update.description !== undefined) setFields.description = update.description;
    if (update.affectedFiles !== undefined) setFields.affectedFiles = JSON.stringify(update.affectedFiles);
    if (update.dependsOn !== undefined) setFields.dependsOn = JSON.stringify(update.dependsOn);
    if (update.workflowTemplateOverride !== undefined) setFields.workflowTemplateOverride = update.workflowTemplateOverride;
    if (update.sortOrder !== undefined) setFields.sortOrder = update.sortOrder;
    if (update.status !== undefined) setFields.status = update.status;

    db.update(schema.proposals)
      .set(setFields)
      .where(eq(schema.proposals.id, proposalId))
      .run();

    return getProposal(proposalId);
  }

  function deleteProposal(proposalId: string): void {
    const existing = getProposal(proposalId);

    if (existing.status === 'launched') {
      throw new ProposalValidationError(
        `Cannot delete proposal ${proposalId}: already launched`,
        { proposalId, status: existing.status },
      );
    }

    db.delete(schema.proposals)
      .where(eq(schema.proposals.id, proposalId))
      .run();
  }

  /**
   * Parse agent output for structured proposals.
   * Expects a JSON array in the agent's output, either bare or
   * wrapped in a markdown code fence.
   */
  function parseProposals(agentOutput: string): ParsedProposal[] {
    const log = logger.child({ op: 'parseProposals' });

    // Try to extract JSON array from the agent output
    // Look for ```json ... ``` fenced block first
    const fenceMatch = agentOutput.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    const jsonCandidate = fenceMatch ? fenceMatch[1].trim() : agentOutput.trim();

    // Try to find a JSON array in the content
    const arrayMatch = jsonCandidate.match(/\[[\s\S]*\]/);
    if (!arrayMatch) {
      log.warn('No JSON array found in agent output, returning empty proposals');
      return [];
    }

    try {
      const parsed = JSON.parse(arrayMatch[0]);
      if (!Array.isArray(parsed)) {
        log.warn('Parsed JSON is not an array');
        return [];
      }

      return parsed.map((item: Record<string, unknown>, idx: number) => ({
        title: String(item.title ?? `Proposal ${idx + 1}`),
        description: String(item.description ?? ''),
        affectedFiles: Array.isArray(item.affectedFiles) ? item.affectedFiles.map(String) : undefined,
        dependsOn: Array.isArray(item.dependsOn) ? item.dependsOn.map(String) : undefined,
      }));
    } catch (err) {
      log.warn({ err }, 'Failed to parse proposals JSON');
      return [];
    }
  }

  /** Map a DB row to the Proposal interface (parse JSON fields) */
  function mapRow(row: typeof schema.proposals.$inferSelect): Proposal {
    return {
      id: row.id,
      workflowRunId: row.workflowRunId,
      stageName: row.stageName,
      parallelGroupId: row.parallelGroupId,
      title: row.title,
      description: row.description,
      affectedFiles: JSON.parse(row.affectedFiles ?? '[]'),
      dependsOn: JSON.parse(row.dependsOn ?? '[]'),
      workflowTemplateOverride: row.workflowTemplateOverride,
      status: row.status,
      launchedWorkflowRunId: row.launchedWorkflowRunId,
      sortOrder: row.sortOrder,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  return {
    createProposal,
    listProposals,
    getProposal,
    getProposalsByRun,
    getProposalsByParallelGroup,
    updateProposal,
    deleteProposal,
    parseProposals,
  };
}
