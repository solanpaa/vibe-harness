// ---------------------------------------------------------------------------
// Integration tests for /api/reviews routes using Hono test client.
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
const testToken = 'test-token-reviews';

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

// Mock workflow/api
vi.mock('workflow/api', () => ({
  start: vi.fn().mockResolvedValue(undefined),
  resumeHook: vi.fn().mockResolvedValue(undefined),
}));

// Mock the reviewDecisionHook.resume
vi.mock('../../src/workflows/hooks.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/workflows/hooks.js')>();
  return {
    ...actual,
    reviewDecisionHook: {
      ...actual.reviewDecisionHook,
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

// Mock runs deps (required by app import path)
vi.mock('../../src/routes/runs.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/routes/runs.js')>();
  return {
    ...actual,
    // setPipelineDeps is kept as-is, runs routes are part of app
  };
});

import app from '../../src/app.js';
import { setPipelineDeps } from '../../src/routes/runs.js';

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
let runId: string;

function createTestRun() {
  runId = crypto.randomUUID();
  testDb.insert(schema.workflowRuns).values({
    id: runId,
    workflowTemplateId: templateId,
    projectId,
    agentDefinitionId: agentDefId,
    status: 'running',
    baseBranch: 'main',
    targetBranch: 'main',
  }).run();
  return runId;
}

function createTestReview(overrides: Record<string, any> = {}) {
  const reviewId = crypto.randomUUID();
  testDb.insert(schema.reviews).values({
    id: reviewId,
    workflowRunId: runId,
    stageName: 'implement',
    round: 1,
    type: 'stage',
    status: 'pending_review',
    diffSnapshot: 'diff --git a/test.ts',
    aiSummary: 'Changes look good.',
    ...overrides,
  }).run();
  return reviewId;
}

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
  const template = testDb.select().from(schema.workflowTemplates).limit(1).get()!;
  templateId = template.id;
  projectId = crypto.randomUUID();
  testDb.insert(schema.projects).values({
    id: projectId,
    name: 'Test Project',
    localPath: '/fake/project',
  }).run();

  // Set pipeline deps (required for app to load runs routes)
  setPipelineDeps({
    sessionManager: {
      create: vi.fn(), continue: vi.fn(), fresh: vi.fn(), stop: vi.fn(),
      sendPrompt: vi.fn(), sendIntervention: vi.fn(),
      awaitCompletion: vi.fn(), isActive: vi.fn().mockReturnValue(true),
    } as any,
    reviewService: { createReview: vi.fn(), bundleCommentsAsPrompt: vi.fn(), getDiff: vi.fn(), capturePlanMarkdown: vi.fn() } as any,
    worktreeService: { create: vi.fn(), remove: vi.fn(), getDiff: vi.fn(), commitAll: vi.fn(), rebase: vi.fn(), mergeBranch: vi.fn(), fastForwardMerge: vi.fn(), listBranches: vi.fn(), exists: vi.fn() } as any,
  });
});

afterEach(() => {
  sqlite.close();
  vi.restoreAllMocks();
});

// ── Tests ────────────────────────────────────────────────────────────

describe('GET /api/reviews/:id', () => {
  it('returns review with comments', async () => {
    createTestRun();
    const reviewId = createTestReview();

    // Add a comment
    testDb.insert(schema.reviewComments).values({
      reviewId,
      filePath: 'src/main.ts',
      lineNumber: 10,
      body: 'Fix this line',
    }).run();

    const res = await req('GET', `/api/reviews/${reviewId}`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.review.id).toBe(reviewId);
    expect(body.review.diffSnapshot).toBeDefined();
    expect(body.comments).toHaveLength(1);
    expect(body.comments[0].body).toBe('Fix this line');
  });

  it('returns 404 for non-existent review', async () => {
    const res = await req('GET', `/api/reviews/${crypto.randomUUID()}`);
    expect(res.status).toBe(404);
  });
});

describe('POST /api/reviews/:id/approve', () => {
  it('writes hookResumes entry and updates status', async () => {
    createTestRun();
    const reviewId = createTestReview();

    const res = await req('POST', `/api/reviews/${reviewId}/approve`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.status).toBe('approved');

    // Verify review status updated in DB
    const review = testDb.select().from(schema.reviews)
      .where(eq(schema.reviews.id, reviewId)).get()!;
    expect(review.status).toBe('approved');
  });

  it('returns 404 for non-existent review', async () => {
    const res = await req('POST', `/api/reviews/${crypto.randomUUID()}/approve`);
    expect(res.status).toBe(404);
  });

  it('returns 409 for already-approved review', async () => {
    createTestRun();
    const reviewId = createTestReview({ status: 'approved' });

    const res = await req('POST', `/api/reviews/${reviewId}/approve`);
    expect(res.status).toBe(409);
  });
});

describe('POST /api/reviews/:id/request-changes', () => {
  it('includes comments and updates status', async () => {
    createTestRun();
    const reviewId = createTestReview();

    const res = await req('POST', `/api/reviews/${reviewId}/request-changes`, {
      comments: [
        { filePath: 'src/auth.ts', body: 'Fix the validation logic' },
        { filePath: null, body: 'Add more tests' },
      ],
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.status).toBe('changes_requested');
    expect(body.commentCount).toBe(2);

    // Verify comments persisted
    const comments = testDb.select().from(schema.reviewComments)
      .where(eq(schema.reviewComments.reviewId, reviewId)).all();
    expect(comments).toHaveLength(2);

    // Verify review status
    const review = testDb.select().from(schema.reviews)
      .where(eq(schema.reviews.id, reviewId)).get()!;
    expect(review.status).toBe('changes_requested');
  });

  it('returns 400 for empty comments array', async () => {
    createTestRun();
    const reviewId = createTestReview();

    const res = await req('POST', `/api/reviews/${reviewId}/request-changes`, {
      comments: [],
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 for missing comments', async () => {
    createTestRun();
    const reviewId = createTestReview();

    const res = await req('POST', `/api/reviews/${reviewId}/request-changes`, {});
    expect(res.status).toBe(400);
  });

  it('returns 404 for non-existent review', async () => {
    const res = await req('POST', `/api/reviews/${crypto.randomUUID()}/request-changes`, {
      comments: [{ filePath: null, body: 'Fix it' }],
    });
    expect(res.status).toBe(404);
  });

  it('returns 409 for non-pending review', async () => {
    createTestRun();
    const reviewId = createTestReview({ status: 'approved' });

    const res = await req('POST', `/api/reviews/${reviewId}/request-changes`, {
      comments: [{ filePath: null, body: 'Fix it' }],
    });
    expect(res.status).toBe(409);
  });

  it('rejects request_changes on consolidation reviews (Fix #11)', async () => {
    createTestRun();
    const reviewId = createTestReview({ type: 'consolidation', stageName: '__consolidation__' });

    const res = await req('POST', `/api/reviews/${reviewId}/request-changes`, {
      comments: [{ filePath: null, body: 'Fix it' }],
    });
    expect(res.status).toBe(409);
    const body = await res.json() as any;
    expect(body.error.message).toContain('consolidation');
  });
});

describe('POST /api/reviews/:id/split', () => {
  let splitTemplateId: string;

  beforeEach(() => {
    // Use the "Plan & Implement" template (has 'implement' stage with splittable flag settable)
    const planTemplate = testDb.select().from(schema.workflowTemplates)
      .where(eq(schema.workflowTemplates.name, 'Plan & Implement')).get();
    splitTemplateId = planTemplate?.id ?? templateId;
  });

  function createSplitRun() {
    runId = crypto.randomUUID();
    testDb.insert(schema.workflowRuns).values({
      id: runId,
      workflowTemplateId: splitTemplateId,
      projectId,
      agentDefinitionId: agentDefId,
      status: 'running',
      baseBranch: 'main',
      targetBranch: 'main',
    }).run();
    return runId;
  }

  function setSplittableOnStage(stageName: string, splittable: boolean) {
    const tmpl = testDb.select().from(schema.workflowTemplates)
      .where(eq(schema.workflowTemplates.id, splitTemplateId)).get()!;
    const stages = JSON.parse(tmpl.stages);
    const idx = stages.findIndex((s: any) => s.name === stageName);
    if (idx >= 0) stages[idx].splittable = splittable;
    testDb.update(schema.workflowTemplates)
      .set({ stages: JSON.stringify(stages) })
      .where(eq(schema.workflowTemplates.id, splitTemplateId)).run();
  }

  function ensureSplitterSettings() {
    testDb.insert(schema.settings)
      .values({ key: 'defaultSplitterPromptTemplate', value: 'Split this: {{description}}\n\n{{extra}}' })
      .onConflictDoUpdate({ target: schema.settings.key, set: { value: 'Split this: {{description}}\n\n{{extra}}' } })
      .run();
    testDb.insert(schema.settings)
      .values({ key: 'defaultPostSplitStages', value: '[]' })
      .onConflictDoUpdate({ target: schema.settings.key, set: { value: '[]' } })
      .run();
  }

  it('returns 404 for non-existent review', async () => {
    const res = await req('POST', `/api/reviews/${crypto.randomUUID()}/split`, { extraDescription: 'x' });
    expect(res.status).toBe(404);
  });

  it('returns 409 when stage is not splittable', async () => {
    ensureSplitterSettings();
    setSplittableOnStage('implement', false);
    createSplitRun();
    const reviewId = createTestReview({ stageName: 'implement' });
    const res = await req('POST', `/api/reviews/${reviewId}/split`, { extraDescription: '' });
    expect(res.status).toBe(409);
    const body = await res.json() as any;
    expect(body.error.message).toMatch(/not splittable/i);
  });

  it('returns 409 for child runs (no recursive split)', async () => {
    ensureSplitterSettings();
    setSplittableOnStage('implement', true);
    // Create a parent run first, then child
    const parentId = crypto.randomUUID();
    testDb.insert(schema.workflowRuns).values({
      id: parentId,
      workflowTemplateId: splitTemplateId,
      projectId,
      agentDefinitionId: agentDefId,
      status: 'running',
    }).run();
    runId = crypto.randomUUID();
    testDb.insert(schema.workflowRuns).values({
      id: runId,
      workflowTemplateId: splitTemplateId,
      projectId,
      agentDefinitionId: agentDefId,
      parentRunId: parentId,
      status: 'running',
    }).run();
    const reviewId = createTestReview({ stageName: 'implement' });
    const res = await req('POST', `/api/reviews/${reviewId}/split`, { extraDescription: '' });
    expect(res.status).toBe(409);
    const body = await res.json() as any;
    expect(body.error.message).toMatch(/child/i);
  });

  it('returns 409 for consolidation reviews', async () => {
    ensureSplitterSettings();
    createSplitRun();
    const reviewId = createTestReview({ type: 'consolidation', stageName: '__consolidation__' });
    const res = await req('POST', `/api/reviews/${reviewId}/split`, { extraDescription: '' });
    expect(res.status).toBe(409);
    const body = await res.json() as any;
    expect(body.error.message).toMatch(/stage reviews/i);
  });

  it('returns 409 when run is already split', async () => {
    ensureSplitterSettings();
    setSplittableOnStage('implement', true);
    createSplitRun();
    testDb.update(schema.workflowRuns)
      .set({ splitConfigJson: '{}' })
      .where(eq(schema.workflowRuns.id, runId)).run();
    const reviewId = createTestReview({ stageName: 'implement' });
    const res = await req('POST', `/api/reviews/${reviewId}/split`, { extraDescription: '' });
    expect(res.status).toBe(409);
    const body = await res.json() as any;
    expect(body.error.message).toMatch(/already been split/i);
  });

  it('returns 409 when review is not pending', async () => {
    ensureSplitterSettings();
    setSplittableOnStage('implement', true);
    createSplitRun();
    const reviewId = createTestReview({ stageName: 'implement', status: 'approved' });
    const res = await req('POST', `/api/reviews/${reviewId}/split`, { extraDescription: '' });
    expect(res.status).toBe(409);
  });

  it('succeeds and persists split_config_json on valid split', async () => {
    ensureSplitterSettings();
    setSplittableOnStage('implement', true);
    createSplitRun();
    const reviewId = createTestReview({ stageName: 'implement' });
    const res = await req('POST', `/api/reviews/${reviewId}/split`, {
      extraDescription: 'Focus on the auth module.',
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.status).toBe('split');
    expect(body.splitConfig).toBeDefined();

    const run = testDb.select().from(schema.workflowRuns)
      .where(eq(schema.workflowRuns.id, runId)).get()!;
    expect(run.splitConfigJson).toBeTruthy();
    const snapshot = JSON.parse(run.splitConfigJson!);
    expect(snapshot.sourceStageName).toBe('implement');
    expect(snapshot.extraDescription).toBe('Focus on the auth module.');
    expect(snapshot.effectiveSplitterPrompt).toContain('Focus on the auth module.');
  });

  it('returns 401 without token', async () => {
    const res = await app.request(`/api/reviews/${crypto.randomUUID()}/split`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ extraDescription: 'x' }),
    });
    expect(res.status).toBe(401);
  });
});

describe('GET /api/reviews', () => {
  it('lists all reviews', async () => {
    createTestRun();
    createTestReview();
    createTestReview({ stageName: 'plan', round: 1 });

    const res = await req('GET', '/api/reviews');
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.reviews.length).toBeGreaterThanOrEqual(2);
  });

  it('filters by runId', async () => {
    createTestRun();
    createTestReview();

    // Create another run with a review
    const otherRunId = crypto.randomUUID();
    testDb.insert(schema.workflowRuns).values({
      id: otherRunId,
      workflowTemplateId: templateId,
      projectId,
      agentDefinitionId: agentDefId,
      status: 'running',
    }).run();
    testDb.insert(schema.reviews).values({
      workflowRunId: otherRunId,
      stageName: 'plan',
      round: 1,
      type: 'stage',
      status: 'pending_review',
    }).run();

    const res = await req('GET', `/api/reviews?runId=${runId}`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.reviews.every((r: any) => r.workflowRunId === runId)).toBe(true);
  });
});

describe('auth required', () => {
  it('GET /api/reviews returns 401 without token', async () => {
    const res = await app.request('/api/reviews', { method: 'GET' });
    expect(res.status).toBe(401);
  });

  it('GET /api/reviews/:id returns 401 without token', async () => {
    const res = await app.request(`/api/reviews/${crypto.randomUUID()}`, { method: 'GET' });
    expect(res.status).toBe(401);
  });

  it('POST /api/reviews/:id/approve returns 401 without token', async () => {
    const res = await app.request(`/api/reviews/${crypto.randomUUID()}/approve`, { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('POST /api/reviews/:id/request-changes returns 401 without token', async () => {
    const res = await app.request(`/api/reviews/${crypto.randomUUID()}/request-changes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ comments: [{ filePath: null, body: 'x' }] }),
    });
    expect(res.status).toBe(401);
  });
});
