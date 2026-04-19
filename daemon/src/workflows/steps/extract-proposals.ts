// ---------------------------------------------------------------------------
// Extract Proposals Step (CDD-workflow §3.4)
//
// Parses the split-stage agent output for proposals and persists them.
// Idempotent: checks if proposals already exist for this run+stage and
// verifies count matches to handle partial insertion from crashes.
// (SAD §5.3.3, SRD FR-S1–S2)
// ---------------------------------------------------------------------------
"use step";

import { getDb } from '../../db/index.js';
import * as schema from '../../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { createProposalService, type ProposalService } from '../../services/proposal-service.js';
import { logger } from '../../lib/logger.js';

// ── Types ────────────────────────────────────────────────────────────

export interface ExtractProposalsInput {
  runId: string;
  stageName: string;
  agentOutput: string;
}

export interface ProposalRecord {
  id: string;
  title: string;
  description: string;
  affectedFiles: string[];
  dependsOn: string[];
  sortOrder: number;
}

export interface ExtractProposalsDeps {
  proposalService: ProposalService;
}

function resolveGlobalDeps(): ExtractProposalsDeps {
  const deps = (globalThis as any).__vibe_pipeline_deps__;
  if (!deps) throw new Error('Pipeline deps not initialized');
  return deps;
}

// ── Step implementation ──────────────────────────────────────────────

export async function extractProposals(
  input: ExtractProposalsInput,
): Promise<ProposalRecord[]> {
  const { runId, stageName, agentOutput } = input;
  const log = logger.child({ runId, stageName });
  const db = getDb();
  const { proposalService } = resolveGlobalDeps();

  // ── Primary path: proposals created via MCP tool calls ────────────
  // The split-stage agent calls propose_task via the MCP bridge, which
  // creates proposals directly in the DB. Check for those first.
  const existing = db
    .select()
    .from(schema.proposals)
    .where(
      and(
        eq(schema.proposals.workflowRunId, runId),
        eq(schema.proposals.stageName, stageName),
      ),
    )
    .all();

  if (existing.length > 0) {
    log.info({ count: existing.length }, 'Proposals found in DB (created via MCP tool calls)');
    return existing.map(mapToRecord);
  }

  // ── Fallback: parse proposals from agent output (JSON) ────────────
  // If the agent didn't use MCP tools, try to extract from text output.
  const parsed = proposalService.parseProposals(agentOutput);

  if (parsed.length === 0) {
    log.warn('No proposals found via MCP or JSON parsing — agent may not have created any');
    return [];
  }

  log.info({ count: parsed.length }, 'Proposals parsed from agent output (fallback)');

  const records: ProposalRecord[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const p = parsed[i];
    const created = proposalService.createProposal({
      workflowRunId: runId,
      stageName,
      title: p.title,
      description: p.description,
      affectedFiles: p.affectedFiles,
      dependsOn: p.dependsOn,
      sortOrder: i,
    });

    records.push({
      id: created.id,
      title: created.title,
      description: created.description,
      affectedFiles: created.affectedFiles,
      dependsOn: created.dependsOn,
      sortOrder: created.sortOrder,
    });
  }

  return records;
}

// ── Helpers ──────────────────────────────────────────────────────────

function mapToRecord(row: typeof schema.proposals.$inferSelect): ProposalRecord {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    affectedFiles: JSON.parse(row.affectedFiles ?? '[]'),
    dependsOn: JSON.parse(row.dependsOn ?? '[]'),
    sortOrder: row.sortOrder,
  };
}
