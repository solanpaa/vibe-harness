// ---------------------------------------------------------------------------
// Integration tests for /api/credentials routes
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
const testToken = 'test-token-creds';

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

// Mock hooks
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

// Mock encryption (avoid touching real key file)
vi.mock('../../src/lib/encryption.js', () => ({
  encrypt: (v: string) => Buffer.from(`enc:${v}`).toString('base64'),
  decrypt: (v: string) => Buffer.from(v, 'base64').toString('utf8').replace('enc:', ''),
}));

// Mock runs deps
vi.mock('../../src/routes/runs.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/routes/runs.js')>();
  return { ...actual };
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

// ── Setup / Teardown ─────────────────────────────────────────────────

beforeEach(() => {
  sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  testDb = drizzle(sqlite, { schema });
  migrate(testDb, { migrationsFolder: MIGRATIONS_DIR });
  seed(testDb);

  projectId = crypto.randomUUID();
  testDb.insert(schema.projects).values({
    id: projectId,
    name: 'Test Project',
    localPath: '/fake/project',
  }).run();

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

describe('POST /api/credentials', () => {
  it('creates a credential set', async () => {
    const res = await req('POST', '/api/credentials', {
      name: 'My Creds',
      description: 'Test creds',
    });
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.name).toBe('My Creds');
    expect(body.id).toBeDefined();
  });

  it('creates a credential set with projectId', async () => {
    const res = await req('POST', '/api/credentials', {
      name: 'Project Creds',
      projectId,
    });
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.projectId).toBe(projectId);
  });

  it('returns 400 for empty name', async () => {
    const res = await req('POST', '/api/credentials', { name: '' });
    expect(res.status).toBe(400);
  });

  it('returns 400 for missing name', async () => {
    const res = await req('POST', '/api/credentials', {});
    expect(res.status).toBe(400);
  });
});

describe('GET /api/credentials', () => {
  it('lists all credential sets with entry counts', async () => {
    // Create two sets
    await req('POST', '/api/credentials', { name: 'Set A' });
    await req('POST', '/api/credentials', { name: 'Set B' });

    const res = await req('GET', '/api/credentials');
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.sets.length).toBeGreaterThanOrEqual(2);
    expect(body.sets[0]).toHaveProperty('entryCount');
  });

  it('filters by projectId', async () => {
    await req('POST', '/api/credentials', { name: 'Global' });
    await req('POST', '/api/credentials', { name: 'Scoped', projectId });

    const res = await req('GET', `/api/credentials?projectId=${projectId}`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.sets.every((s: any) => s.projectId === projectId)).toBe(true);
  });
});

describe('GET /api/credentials/:id', () => {
  it('returns credential set with masked entries', async () => {
    const createRes = await req('POST', '/api/credentials', { name: 'Detail Set' });
    const { id: setId } = await createRes.json() as any;

    // Add an entry
    await req('POST', `/api/credentials/${setId}/entries`, {
      key: 'API_KEY',
      value: 'secret-value',
      type: 'env_var',
    });

    const res = await req('GET', `/api/credentials/${setId}`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.set.name).toBe('Detail Set');
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].key).toBe('API_KEY');
    // Value should NOT be present (masked)
    expect(body.entries[0].value).toBeUndefined();
  });

  it('returns 404 for non-existent set', async () => {
    const res = await req('GET', `/api/credentials/${crypto.randomUUID()}`);
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/credentials/:id', () => {
  it('deletes a credential set', async () => {
    const createRes = await req('POST', '/api/credentials', { name: 'ToDelete' });
    const { id: setId } = await createRes.json() as any;

    const res = await req('DELETE', `/api/credentials/${setId}`);
    expect(res.status).toBe(204);

    // Verify gone
    const getRes = await req('GET', `/api/credentials/${setId}`);
    expect(getRes.status).toBe(404);
  });

  it('returns 404 for non-existent set', async () => {
    const res = await req('DELETE', `/api/credentials/${crypto.randomUUID()}`);
    expect(res.status).toBe(404);
  });
});

describe('POST /api/credentials/:id/entries', () => {
  let setId: string;

  beforeEach(async () => {
    const createRes = await req('POST', '/api/credentials', { name: 'Entry Set' });
    setId = ((await createRes.json()) as any).id;
  });

  it('adds an env_var entry', async () => {
    const res = await req('POST', `/api/credentials/${setId}/entries`, {
      key: 'MY_SECRET',
      value: 'secret123',
      type: 'env_var',
    });
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.key).toBe('MY_SECRET');
    expect(body.type).toBe('env_var');
    // Encrypted value should NOT be returned
    expect(body.value).toBeUndefined();
  });

  it('adds a file_mount entry', async () => {
    const res = await req('POST', `/api/credentials/${setId}/entries`, {
      key: 'ssh_key',
      value: '/home/user/.ssh/id_rsa',
      type: 'file_mount',
      mountPath: '/root/.ssh/id_rsa',
    });
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.type).toBe('file_mount');
    expect(body.mountPath).toBe('/root/.ssh/id_rsa');
  });

  it('rejects file_mount entry without mountPath', async () => {
    const res = await req('POST', `/api/credentials/${setId}/entries`, {
      key: 'ssh_key',
      value: '/home/user/.ssh/id_rsa',
      type: 'file_mount',
    });
    expect(res.status).toBe(400);
  });

  it('rejects file_mount entry without value (host path)', async () => {
    const res = await req('POST', `/api/credentials/${setId}/entries`, {
      key: 'ssh_key',
      type: 'file_mount',
      mountPath: '/root/.ssh/id_rsa',
    });
    expect(res.status).toBe(400);
  });

  it('returns 404 for non-existent set', async () => {
    const res = await req('POST', `/api/credentials/${crypto.randomUUID()}/entries`, {
      key: 'K',
      value: 'V',
      type: 'env_var',
    });
    expect(res.status).toBe(404);
  });

  it('returns 400 for invalid type', async () => {
    const res = await req('POST', `/api/credentials/${setId}/entries`, {
      key: 'K',
      value: 'V',
      type: 'invalid_type',
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 for missing key', async () => {
    const res = await req('POST', `/api/credentials/${setId}/entries`, {
      value: 'V',
      type: 'env_var',
    });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/credentials/:id/entries/:entryId', () => {
  it('deletes a credential entry', async () => {
    const createRes = await req('POST', '/api/credentials', { name: 'Del Entry Set' });
    const setId = ((await createRes.json()) as any).id;

    const entryRes = await req('POST', `/api/credentials/${setId}/entries`, {
      key: 'TO_DELETE',
      value: 'val',
      type: 'env_var',
    });
    const entryId = ((await entryRes.json()) as any).id;

    const res = await req('DELETE', `/api/credentials/${setId}/entries/${entryId}`);
    expect(res.status).toBe(204);
  });
});

describe('GET /api/credentials/:id/entries/:entryId/reveal', () => {
  let setId: string;
  let entryId: string;

  beforeEach(async () => {
    const createRes = await req('POST', '/api/credentials', { name: 'Reveal Set' });
    setId = ((await createRes.json()) as any).id;
    const entryRes = await req('POST', `/api/credentials/${setId}/entries`, {
      key: 'API_KEY',
      value: 'plaintext-secret',
      type: 'env_var',
    });
    entryId = ((await entryRes.json()) as any).id;
  });

  it('returns the decrypted value', async () => {
    const res = await req('GET', `/api/credentials/${setId}/entries/${entryId}/reveal`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.value).toBe('plaintext-secret');
  });

  it('writes a "revealed" audit log entry', async () => {
    await req('GET', `/api/credentials/${setId}/entries/${entryId}/reveal`);
    const auditRes = await req('GET', `/api/credentials/audit?credentialSetId=${setId}`);
    const audit = await auditRes.json() as any;
    expect(audit.entries.some((e: any) =>
      e.action === 'revealed' && e.credentialEntryId === entryId,
    )).toBe(true);
  });

  it('returns 404 for non-existent entry', async () => {
    const res = await req('GET', `/api/credentials/${setId}/entries/${crypto.randomUUID()}/reveal`);
    expect(res.status).toBe(404);
  });

  it('returns 400 when entry does not belong to set', async () => {
    const otherSetRes = await req('POST', '/api/credentials', { name: 'Other Set' });
    const otherSetId = ((await otherSetRes.json()) as any).id;
    const res = await req('GET', `/api/credentials/${otherSetId}/entries/${entryId}/reveal`);
    expect(res.status).toBe(400);
  });
});

describe('GET /api/credentials/audit', () => {
  it('returns audit log entries', async () => {
    // Create a set (generates audit entries)
    await req('POST', '/api/credentials', { name: 'Audited Set' });

    const res = await req('GET', '/api/credentials/audit');
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.entries.length).toBeGreaterThanOrEqual(1);
    expect(body.total).toBe(body.entries.length);
    expect(body.entries[0]).toHaveProperty('action');
    expect(body.entries[0]).toHaveProperty('createdAt');
  });

  it('filters by credentialSetId', async () => {
    const r1 = await req('POST', '/api/credentials', { name: 'Audit A' });
    const setIdA = ((await r1.json()) as any).id;
    await req('POST', '/api/credentials', { name: 'Audit B' });

    const res = await req('GET', `/api/credentials/audit?credentialSetId=${setIdA}`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.entries.every((e: any) => e.credentialSetId === setIdA)).toBe(true);
  });
});

describe('auth required', () => {
  it('GET /api/credentials returns 401 without token', async () => {
    const res = await app.request('/api/credentials', { method: 'GET' });
    expect(res.status).toBe(401);
  });

  it('POST /api/credentials returns 401 without token', async () => {
    const res = await app.request('/api/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    });
    expect(res.status).toBe(401);
  });
});
