// ---------------------------------------------------------------------------
// Integration tests for /api/proposals routes using Hono test client.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from '../../src/db/schema.js';
import { seed } from '../../src/db/seed.js';
import { join } from 'node:path';

const MIGRATIONS_DIR = join(process.cwd(), 'drizzle');

let sqlite: Database.Database;
let testDb: ReturnType<typeof drizzle<typeof schema>>;
const testToken = 'test-token-proposals';

// ── Module mocks ─────────────────────────────────────────────────────

vi.mock('../../src/db/index.js', () => ({
  getDb: () => testDb,
  closeDb: () => {},
  getRawDb: () => sqlite,
}));

vi.mock('../../src/lib/auth.js', async () => {
  const { createMiddleware } = await import('hono/factory');
  return {
    generateToken: () => testToken,
    getOrCreateToken: () => testToken,
    authMiddleware: () =>
      createMiddleware(async (c, next) => {
        if (c.req.path === '/health' || c.req.path === '/ws') {
          return next();
        }
        const authHeader = c.req.header('Authorization');
        if (!authHeader?.startsWith('Bearer ')) {
          return c.json({ error: 'Unauthorized' }, 401);
        }
        if (authHeader.slice('Bearer '.length) !== testToken) {
          return c.json({ error: 'Unauthorized' }, 401);
        }
        return next();
      }),
  };
});

vi.mock('workflow/api', () => ({
  start: vi.fn().mockResolvedValue(undefined),
  resumeHook: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/workflows/hooks.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/workflows/hooks.js')>();
  return {
    ...actual,
    stageFailedHook: {
      ...actual.stageFailedHook,
      resume: vi.fn().mockResolvedValue(undefined),
    },
    proposalReviewHook: {
      ...actual.proposalReviewHook,
      resume: vi.fn().mockResolvedValue(undefined),
    },
  };
});

vi.mock('../../src/lib/logger.js', () => ({
  logger: {
    child: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  },
}));

vi.mock('../../src/services/credential-vault.js', () => ({
  createCredentialSet: () => ({ id: 'mock', name: 'mock' }),
  getCredentialSet: () => null,
  listCredentialSets: () => [],
  deleteCredentialSet: () => {},
  addCredentialEntry: () => ({ id: 'mock', key: 'mock' }),
  getCredentialEntries: () => [],
  deleteCredentialEntry: () => {},
  getAuditLog: () => [],
  getEntryCount: () => 0,
}));

vi.mock('../../src/lib/shell.js', () => ({
  execCommand: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
}));

const { default: app } = await import('../../src/app.js');

// ── Helpers ──────────────────────────────────────────────────────────

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${testToken}` };
}

function req(path: string, init?: RequestInit): Request {
  return new Request(`http://localhost${path}`, init);
}

let workflowRunId: string;

beforeEach(() => {
  sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  testDb = drizzle(sqlite, { schema });
  migrate(testDb, { migrationsFolder: MIGRATIONS_DIR });
  seed(testDb);

  const project = testDb
    .insert(schema.projects)
    .values({ name: 'Proposal Test', localPath: '/fake' })
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
      description: 'proposals route test',
      status: 'running',
    })
    .returning()
    .get();
  workflowRunId = run.id;
});

afterEach(() => {
  sqlite.close();
});

// ── GET /api/proposals ──────────────────────────────────────────────

describe('GET /api/proposals', () => {
  it('returns proposals for a specific runId', async () => {
    // Seed a proposal via DB
    testDb
      .insert(schema.proposals)
      .values({
        workflowRunId,
        stageName: 'plan',
        title: 'Test Proposal',
        description: 'Some desc',
        affectedFiles: '[]',
        dependsOn: '[]',
        status: 'proposed',
        sortOrder: 0,
      })
      .run();

    const res = await app.request(
      req(`/api/proposals?runId=${workflowRunId}`, { headers: authHeaders() }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.proposals).toHaveLength(1);
    expect(body.proposals[0].title).toBe('Test Proposal');
  });

  it('returns 400 when runId is missing', async () => {
    const res = await app.request(
      req('/api/proposals', { headers: authHeaders() }),
    );
    expect(res.status).toBe(400);
  });

  it('returns empty array for unknown runId', async () => {
    const res = await app.request(
      req('/api/proposals?runId=00000000-0000-0000-0000-000000000000', {
        headers: authHeaders(),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.proposals).toEqual([]);
  });
});

// ── POST /api/proposals ─────────────────────────────────────────────

describe('POST /api/proposals', () => {
  it('creates a proposal and returns 201', async () => {
    const res = await app.request(
      req('/api/proposals', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workflowRunId,
          stageName: 'plan',
          title: 'New Proposal',
          description: 'Do the thing',
        }),
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.title).toBe('New Proposal');
    expect(body.id).toBeTruthy();
  });

  it('returns 400 for invalid input (missing title)', async () => {
    const res = await app.request(
      req('/api/proposals', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workflowRunId,
          stageName: 'plan',
          description: 'missing title',
        }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid workflowRunId format', async () => {
    const res = await app.request(
      req('/api/proposals', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workflowRunId: 'not-a-uuid',
          stageName: 'plan',
          title: 'Bad',
          description: 'Bad',
        }),
      }),
    );
    expect(res.status).toBe(400);
  });
});

// ── PATCH /api/proposals/:id ────────────────────────────────────────

describe('PATCH /api/proposals/:id', () => {
  it('updates a proposal', async () => {
    const created = testDb
      .insert(schema.proposals)
      .values({
        workflowRunId,
        stageName: 'plan',
        title: 'Original',
        description: 'Original desc',
        affectedFiles: '[]',
        dependsOn: '[]',
        status: 'proposed',
        sortOrder: 0,
      })
      .returning()
      .get();

    const res = await app.request(
      req(`/api/proposals/${created.id}`, {
        method: 'PATCH',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Updated Title' }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.title).toBe('Updated Title');
  });

  it('returns 404 for non-existent proposal', async () => {
    const res = await app.request(
      req('/api/proposals/00000000-0000-0000-0000-000000000000', {
        method: 'PATCH',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'x' }),
      }),
    );
    expect(res.status).toBe(404);
  });
});

// ── DELETE /api/proposals/:id ───────────────────────────────────────

describe('DELETE /api/proposals/:id', () => {
  it('deletes a proposal', async () => {
    const created = testDb
      .insert(schema.proposals)
      .values({
        workflowRunId,
        stageName: 'plan',
        title: 'To Delete',
        description: 'Bye',
        affectedFiles: '[]',
        dependsOn: '[]',
        status: 'proposed',
        sortOrder: 0,
      })
      .returning()
      .get();

    const res = await app.request(
      req(`/api/proposals/${created.id}`, {
        method: 'DELETE',
        headers: authHeaders(),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('deleted');

    // Verify it's gone
    const check = await app.request(
      req(`/api/proposals?runId=${workflowRunId}`, { headers: authHeaders() }),
    );
    const checkBody = await check.json();
    expect(checkBody.proposals).toHaveLength(0);
  });

  it('returns 404 for non-existent proposal', async () => {
    const res = await app.request(
      req('/api/proposals/00000000-0000-0000-0000-000000000000', {
        method: 'DELETE',
        headers: authHeaders(),
      }),
    );
    expect(res.status).toBe(404);
  });
});

// ── Auth enforcement ────────────────────────────────────────────────

describe('Auth enforcement on proposals', () => {
  it('returns 401 on GET without token', async () => {
    const res = await app.request(req(`/api/proposals?runId=${workflowRunId}`));
    expect(res.status).toBe(401);
  });

  it('returns 401 on POST without token', async () => {
    const res = await app.request(
      req('/api/proposals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workflowRunId,
          stageName: 'plan',
          title: 'x',
          description: 'x',
        }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it('returns 401 on PATCH without token', async () => {
    const res = await app.request(
      req('/api/proposals/some-id', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'x' }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it('returns 401 on DELETE without token', async () => {
    const res = await app.request(
      req('/api/proposals/some-id', { method: 'DELETE' }),
    );
    expect(res.status).toBe(401);
  });
});
