// ---------------------------------------------------------------------------
// Unit tests for ProposalService (proposal-service.ts)
//
// Uses a real in-memory SQLite DB with Drizzle + migrations.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from '../../src/db/schema.js';
import { seed } from '../../src/db/seed.js';
import { join } from 'node:path';
import { createProposalService, type ProposalService, type ProposalInput } from '../../src/services/proposal-service.js';
import type { Logger } from 'pino';

const MIGRATIONS_DIR = join(process.cwd(), 'drizzle');

let sqlite: Database.Database;
let testDb: ReturnType<typeof drizzle<typeof schema>>;
let service: ProposalService;

let workflowRunId: string;

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLogger,
} as unknown as Logger;

function makeInput(overrides: Partial<ProposalInput> = {}): ProposalInput {
  return {
    workflowRunId,
    stageName: 'plan',
    title: 'Refactor auth module',
    description: 'Extract JWT logic into a shared util',
    ...overrides,
  };
}

beforeEach(() => {
  sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  testDb = drizzle(sqlite, { schema });
  migrate(testDb, { migrationsFolder: MIGRATIONS_DIR });
  seed(testDb);

  // Create FK-valid parent records
  const project = testDb
    .insert(schema.projects)
    .values({ name: 'Test Project', localPath: '/fake' })
    .returning()
    .get();
  const agent = testDb.select().from(schema.agentDefinitions).all()[0];
  const tmpl = testDb.select().from(schema.workflowTemplates).all()[0];

  const run = testDb
    .insert(schema.workflowRuns)
    .values({
      workflowTemplateId: tmpl.id,
      projectId: project.id,
      agentDefinitionId: agent.id,
      description: 'test run',
      status: 'running',
    })
    .returning()
    .get();
  workflowRunId = run.id;

  service = createProposalService({ logger: noopLogger, db: testDb });
});

afterEach(() => {
  sqlite.close();
});

// ── CRUD ─────────────────────────────────────────────────────────────

describe('createProposal', () => {
  it('creates a record and returns it with all fields', () => {
    const proposal = service.createProposal(makeInput());

    expect(proposal.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(proposal.workflowRunId).toBe(workflowRunId);
    expect(proposal.stageName).toBe('plan');
    expect(proposal.title).toBe('Refactor auth module');
    expect(proposal.description).toBe('Extract JWT logic into a shared util');
    expect(proposal.status).toBe('proposed');
    expect(proposal.affectedFiles).toEqual([]);
    expect(proposal.dependsOn).toEqual([]);
    expect(proposal.sortOrder).toBe(0);
    expect(proposal.createdAt).toBeTruthy();
  });

  it('persists affectedFiles and dependsOn arrays', () => {
    const proposal = service.createProposal(
      makeInput({
        affectedFiles: ['src/auth.ts', 'src/utils.ts'],
        dependsOn: ['other-proposal'],
      }),
    );

    expect(proposal.affectedFiles).toEqual(['src/auth.ts', 'src/utils.ts']);
    expect(proposal.dependsOn).toEqual(['other-proposal']);
  });

  it('is idempotent — same (runId, stageName, title) returns existing', () => {
    const first = service.createProposal(makeInput());
    const second = service.createProposal(makeInput());

    expect(first.id).toBe(second.id);

    // Only one row in DB
    const all = service.listProposals(workflowRunId);
    expect(all).toHaveLength(1);
  });

  it('allows different titles for the same run+stage', () => {
    service.createProposal(makeInput({ title: 'Proposal A' }));
    service.createProposal(makeInput({ title: 'Proposal B' }));

    const all = service.listProposals(workflowRunId);
    expect(all).toHaveLength(2);
  });
});

describe('listProposals', () => {
  it('returns proposals for a specific run', () => {
    service.createProposal(makeInput({ title: 'P1', sortOrder: 1 }));
    service.createProposal(makeInput({ title: 'P2', sortOrder: 0 }));

    const list = service.listProposals(workflowRunId);
    expect(list).toHaveLength(2);
    // Ordered by sortOrder ascending
    expect(list[0].title).toBe('P2');
    expect(list[1].title).toBe('P1');
  });

  it('returns empty array for unknown runId', () => {
    const list = service.listProposals('00000000-0000-0000-0000-000000000000');
    expect(list).toEqual([]);
  });

  it('filters by stageName', () => {
    service.createProposal(makeInput({ stageName: 'plan', title: 'Plan P' }));
    service.createProposal(makeInput({ stageName: 'implement', title: 'Impl P' }));

    const planOnly = service.listProposals(workflowRunId, { stageName: 'plan' });
    expect(planOnly).toHaveLength(1);
    expect(planOnly[0].title).toBe('Plan P');
  });

  it('filters by status', () => {
    const p = service.createProposal(makeInput({ title: 'Approved' }));
    service.updateProposal(p.id, { status: 'approved' });
    service.createProposal(makeInput({ title: 'Still proposed' }));

    const approved = service.listProposals(workflowRunId, { status: 'approved' });
    expect(approved).toHaveLength(1);
    expect(approved[0].title).toBe('Approved');
  });
});

describe('updateProposal', () => {
  it('modifies title and description', () => {
    const p = service.createProposal(makeInput());

    const updated = service.updateProposal(p.id, {
      title: 'New title',
      description: 'New desc',
    });

    expect(updated.title).toBe('New title');
    expect(updated.description).toBe('New desc');
    expect(updated.id).toBe(p.id);
  });

  it('modifies affectedFiles', () => {
    const p = service.createProposal(makeInput());
    const updated = service.updateProposal(p.id, {
      affectedFiles: ['a.ts', 'b.ts'],
    });
    expect(updated.affectedFiles).toEqual(['a.ts', 'b.ts']);
  });

  it('updates sortOrder', () => {
    const p = service.createProposal(makeInput());
    const updated = service.updateProposal(p.id, { sortOrder: 5 });
    expect(updated.sortOrder).toBe(5);
  });

  it('throws ProposalNotFoundError for unknown id', () => {
    expect(() =>
      service.updateProposal('00000000-0000-0000-0000-000000000000', { title: 'x' }),
    ).toThrow(/not found/i);
  });
});

describe('deleteProposal', () => {
  it('removes the record', () => {
    const p = service.createProposal(makeInput());
    service.deleteProposal(p.id);

    expect(() => service.getProposal(p.id)).toThrow(/not found/i);
  });

  it('throws ProposalNotFoundError for unknown id', () => {
    expect(() =>
      service.deleteProposal('00000000-0000-0000-0000-000000000000'),
    ).toThrow(/not found/i);
  });
});

// ── parseProposals ───────────────────────────────────────────────────

describe('parseProposals', () => {
  it('extracts proposals from JSON agent output', () => {
    const output = JSON.stringify([
      { title: 'Auth refactor', description: 'Move JWT to shared', affectedFiles: ['auth.ts'] },
      { title: 'DB migration', description: 'Add users table' },
    ]);

    const parsed = service.parseProposals(output);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].title).toBe('Auth refactor');
    expect(parsed[0].affectedFiles).toEqual(['auth.ts']);
    expect(parsed[1].title).toBe('DB migration');
    expect(parsed[1].affectedFiles).toBeUndefined();
  });

  it('extracts proposals from markdown code fence', () => {
    const output = `Here are my proposals:\n\`\`\`json\n[{"title":"A","description":"desc A"}]\n\`\`\`\nDone.`;

    const parsed = service.parseProposals(output);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].title).toBe('A');
  });

  it('handles malformed output gracefully (returns empty)', () => {
    expect(service.parseProposals('no json here')).toEqual([]);
    expect(service.parseProposals('')).toEqual([]);
    expect(service.parseProposals('{ not an array }')).toEqual([]);
  });

  it('handles completely invalid JSON in a code fence', () => {
    const output = '```json\n{broken json[[\n```';
    expect(service.parseProposals(output)).toEqual([]);
  });

  it('assigns fallback titles when title is missing', () => {
    const output = JSON.stringify([{ description: 'no title here' }]);
    const parsed = service.parseProposals(output);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].title).toBe('Proposal 1');
  });
});
