// ---------------------------------------------------------------------------
// Integration tests for /api/runs routes using Hono test client.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import * as schema from '../../src/db/schema.js';
import { seed } from '../../src/db/seed.js';
import { join } from 'node:path';

const MIGRATIONS_DIR = join(process.cwd(), 'drizzle');

let sqlite: Database.Database;
let testDb: ReturnType<typeof drizzle<typeof schema>>;
const testToken = 'test-token-runs';

// Mock getDb
vi.mock('../../src/db/index.js', () => ({
  getDb: () => testDb,
  closeDb: () => {},
  getRawDb: () => sqlite,
}));

// Mock auth
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

// Mock workflow/api — we can't run real workflow runtime in tests
vi.mock('workflow/api', () => ({
  start: vi.fn().mockResolvedValue(undefined),
  resumeHook: vi.fn().mockResolvedValue(undefined),
}));

// Mock the stageFailedHook.resume — the runs route calls it directly
vi.mock('../../src/workflows/hooks.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/workflows/hooks.js')>();
  return {
    ...actual,
    stageFailedHook: {
      ...actual.stageFailedHook,
      resume: vi.fn().mockResolvedValue(undefined),
    },
  };
});

// Mock logger
vi.mock('../../src/lib/logger.js', () => ({
  logger: {
    child: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  },
}));

// Import the app and route dep setter after mocks
import app from '../../src/app.js';
import { setPipelineDeps } from '../../src/routes/runs.js';
import type { SessionManager } from '../../src/services/session-manager.js';

// ── Helpers ──────────────────────────────────────────────────────────

const auth = { Authorization: `Bearer ${testToken}` };

function req(method: string, path: string, body?: any) {
  const init: RequestInit = {
    method,
    headers: { ...auth, 'Content-Type': 'application/json' },
  };
  if (body) init.body = JSON.stringify(body);
  return app.request(path, init);
}

let projectId: string;
let agentDefId: string;
let templateId: string;

// ── Setup / Teardown ─────────────────────────────────────────────────

beforeEach(() => {
  sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  testDb = drizzle(sqlite, { schema });
  migrate(testDb, { migrationsFolder: MIGRATIONS_DIR });
  seed(testDb);

  const agent = testDb.select().from(schema.agentDefinitions).limit(1).get()!;
  agentDefId = agent.id;
  // The seeded copilot agent ships with a `dockerImage` that POST /api/runs
  // pre-flight-checks against the host's Docker daemon. Clear it for these
  // route-level tests so the check is skipped (we're testing route logic,
  // not the host's image cache).
  testDb.update(schema.agentDefinitions)
    .set({ dockerImage: '' })
    .where(eq(schema.agentDefinitions.id, agent.id))
    .run();
  const template = testDb.select().from(schema.workflowTemplates).limit(1).get()!;
  templateId = template.id;
  projectId = crypto.randomUUID();
  testDb.insert(schema.projects).values({
    id: projectId,
    name: 'Test Project',
    localPath: '/fake/project',
  }).run();

  // Set up mock pipeline deps
  const mockSm: SessionManager = {
    create: vi.fn().mockResolvedValue(undefined),
    continue: vi.fn().mockResolvedValue(undefined),
    fresh: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    sendPrompt: vi.fn().mockResolvedValue(undefined),
    sendIntervention: vi.fn().mockResolvedValue(undefined),
    awaitCompletion: vi.fn().mockResolvedValue({
      status: 'completed',
      lastAssistantMessage: 'Done',
      planMarkdown: null,
    }),
    isActive: vi.fn().mockReturnValue(true),
  };

  setPipelineDeps({
    sessionManager: mockSm,
    reviewService: {
      createReview: vi.fn().mockResolvedValue({ reviewId: 'r1', alreadyExisted: false }),
      bundleCommentsAsPrompt: vi.fn().mockResolvedValue({ markdown: '', commentCount: 0 }),
      getDiff: vi.fn().mockResolvedValue({ rawDiff: '', files: [], stats: { filesChanged: 0, insertions: 0, deletions: 0 } }),
      capturePlanMarkdown: vi.fn().mockResolvedValue(null),
    } as any,
    worktreeService: {
      create: vi.fn().mockResolvedValue({ worktreePath: '/wt', branch: 'b' }),
      remove: vi.fn().mockResolvedValue(undefined),
      getDiff: vi.fn().mockResolvedValue({ rawDiff: '', files: [], stats: { filesChanged: 0, insertions: 0, deletions: 0 } }),
      commitAll: vi.fn().mockResolvedValue({ committed: true }),
      rebase: vi.fn().mockResolvedValue({ success: true }),
      mergeBranch: vi.fn().mockResolvedValue({ success: true }),
      fastForwardMerge: vi.fn().mockResolvedValue(undefined),
      listBranches: vi.fn().mockResolvedValue(['main']),
      exists: vi.fn().mockResolvedValue(true),
    } as any,
  });
});

afterEach(() => {
  sqlite.close();
  vi.restoreAllMocks();
});

// ── Tests ────────────────────────────────────────────────────────────

describe('POST /api/runs', () => {
  it('creates a workflow run record', async () => {
    const res = await req('POST', '/api/runs', {
      workflowTemplateId: templateId,
      projectId,
      agentDefinitionId: agentDefId,
      description: 'Test run',
    });
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.id).toBeDefined();
    expect(body.status).toBe('pending');
    expect(body.projectId).toBe(projectId);
  });

  it('returns 400 for invalid input', async () => {
    const res = await req('POST', '/api/runs', { description: 'missing fields' });
    expect(res.status).toBe(400);
  });

  it('returns 404 for non-existent project', async () => {
    const res = await req('POST', '/api/runs', {
      workflowTemplateId: templateId,
      projectId: crypto.randomUUID(),
      agentDefinitionId: agentDefId,
    });
    expect(res.status).toBe(404);
  });

  it('returns 404 for non-existent template', async () => {
    const res = await req('POST', '/api/runs', {
      workflowTemplateId: crypto.randomUUID(),
      projectId,
      agentDefinitionId: agentDefId,
    });
    expect(res.status).toBe(404);
  });

  it('returns 404 for non-existent agent', async () => {
    const res = await req('POST', '/api/runs', {
      workflowTemplateId: templateId,
      projectId,
      agentDefinitionId: crypto.randomUUID(),
    });
    expect(res.status).toBe(404);
  });

  it('returns 409 AGENT_IMAGE_MISSING when agent image is not present locally', async () => {
    // Restore a docker image reference that almost certainly does not exist,
    // so the pre-flight `docker image inspect` fails and we exercise the gate.
    testDb.update(schema.agentDefinitions)
      .set({ dockerImage: 'vibe-harness-test/definitely-missing:does-not-exist' })
      .where(eq(schema.agentDefinitions.id, agentDefId))
      .run();

    const res = await req('POST', '/api/runs', {
      workflowTemplateId: templateId,
      projectId,
      agentDefinitionId: agentDefId,
      description: 'should be blocked',
    });
    expect(res.status).toBe(409);
    const body = await res.json() as any;
    expect(body.error.code).toBe('AGENT_IMAGE_MISSING');
    expect(body.error.agentDefinitionId).toBe(agentDefId);
    expect(body.error.image).toBe('vibe-harness-test/definitely-missing:does-not-exist');
  });
});

describe('GET /api/runs', () => {
  it('lists runs', async () => {
    // Create a run first
    await req('POST', '/api/runs', {
      workflowTemplateId: templateId,
      projectId,
      agentDefinitionId: agentDefId,
    });

    const res = await req('GET', '/api/runs');
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.runs).toBeDefined();
    expect(body.runs.length).toBeGreaterThanOrEqual(1);
  });

  it('returns empty array when no runs exist', async () => {
    const res = await req('GET', '/api/runs');
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.runs).toEqual([]);
  });
});

describe('GET /api/runs/:id', () => {
  it('returns run with stages and reviews', async () => {
    const createRes = await req('POST', '/api/runs', {
      workflowTemplateId: templateId,
      projectId,
      agentDefinitionId: agentDefId,
    });
    const created = await createRes.json() as any;

    const res = await req('GET', `/api/runs/${created.id}`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.id).toBe(created.id);
    expect(body.stages).toBeDefined();
    expect(body.reviews).toBeDefined();
  });

  it('returns 404 for non-existent run', async () => {
    const res = await req('GET', `/api/runs/${crypto.randomUUID()}`);
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/runs/:id/cancel', () => {
  it('cancels a running workflow', async () => {
    const runId = crypto.randomUUID();
    testDb.insert(schema.workflowRuns).values({
      id: runId,
      workflowTemplateId: templateId,
      projectId,
      agentDefinitionId: agentDefId,
      status: 'running',
    }).run();

    const res = await req('PATCH', `/api/runs/${runId}/cancel`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.status).toBe('cancelled');

    // Verify DB updated
    const run = testDb.select().from(schema.workflowRuns)
      .where(eq(schema.workflowRuns.id, runId)).get()!;
    expect(run.status).toBe('cancelled');
  });

  it('returns 404 for non-existent run', async () => {
    const res = await req('PATCH', `/api/runs/${crypto.randomUUID()}/cancel`);
    expect(res.status).toBe(404);
  });

  it('returns 409 for already completed run', async () => {
    const runId = crypto.randomUUID();
    testDb.insert(schema.workflowRuns).values({
      id: runId,
      workflowTemplateId: templateId,
      projectId,
      agentDefinitionId: agentDefId,
      status: 'completed',
    }).run();

    const res = await req('PATCH', `/api/runs/${runId}/cancel`);
    expect(res.status).toBe(409);
  });
});

describe('POST /api/runs/:id/message', () => {
  it('sends intervention to running workflow', async () => {
    const runId = crypto.randomUUID();
    testDb.insert(schema.workflowRuns).values({
      id: runId,
      workflowTemplateId: templateId,
      projectId,
      agentDefinitionId: agentDefId,
      status: 'running',
    }).run();

    const res = await req('POST', `/api/runs/${runId}/message`, {
      message: 'Please focus on the auth module',
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.status).toBe('sent');
  });

  it('returns 404 for non-existent run', async () => {
    const res = await req('POST', `/api/runs/${crypto.randomUUID()}/message`, {
      message: 'hello',
    });
    expect(res.status).toBe(404);
  });

  it('returns 409 for non-running workflow', async () => {
    const runId = crypto.randomUUID();
    testDb.insert(schema.workflowRuns).values({
      id: runId,
      workflowTemplateId: templateId,
      projectId,
      agentDefinitionId: agentDefId,
      status: 'awaiting_review',
    }).run();

    const res = await req('POST', `/api/runs/${runId}/message`, {
      message: 'hello',
    });
    expect(res.status).toBe(409);
  });

  it('returns 400 for missing message', async () => {
    const runId = crypto.randomUUID();
    testDb.insert(schema.workflowRuns).values({
      id: runId,
      workflowTemplateId: templateId,
      projectId,
      agentDefinitionId: agentDefId,
      status: 'running',
    }).run();

    const res = await req('POST', `/api/runs/${runId}/message`, {});
    expect(res.status).toBe(400);
  });
});

describe('auth required on all endpoints', () => {
  it('GET /api/runs returns 401 without token', async () => {
    const res = await app.request('/api/runs', { method: 'GET' });
    expect(res.status).toBe(401);
  });

  it('POST /api/runs returns 401 without token', async () => {
    const res = await app.request('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });

  it('PATCH /api/runs/:id/cancel returns 401 without token', async () => {
    const res = await app.request(`/api/runs/${crypto.randomUUID()}/cancel`, { method: 'PATCH' });
    expect(res.status).toBe(401);
  });

  it('POST /api/runs/:id/message returns 401 without token', async () => {
    const res = await app.request(`/api/runs/${crypto.randomUUID()}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hi' }),
    });
    expect(res.status).toBe(401);
  });
});
