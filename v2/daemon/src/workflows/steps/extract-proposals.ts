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

  // ── Idempotency: check if proposals already exist for this stage ──
  // Fix #3: Check both existence AND completeness. We parse the expected
  // proposals first (deterministic), then compare count with existing rows.
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

  // Parse to determine expected count (deterministic — same input always
  // produces the same parsed output).
  const parsed = proposalService.parseProposals(agentOutput);

  if (existing.length > 0 && existing.length === parsed.length) {
    log.info({ count: existing.length }, 'Proposals already extracted, returning cached');
    return existing.map(mapToRecord);
  }

  // If we have a partial set (crash during previous insertion), we need
  // to create only the missing proposals. Build a set of already-persisted
  // titles for deduplication (titles are unique per run+stage).
  const existingTitles = new Set(existing.map((e) => e.title));

  // ── Persist each proposal (skip already-created ones) ─────────────
  const records: ProposalRecord[] = existing.map(mapToRecord);

  for (let i = 0; i < parsed.length; i++) {
    const p = parsed[i];
    if (existingTitles.has(p.title)) {
      continue; // Already persisted in a prior partial run
    }

    // Use the service's idempotent createProposal (UNIQUE constraint)
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

  log.info({ count: records.length }, 'Proposals extracted and persisted');
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
