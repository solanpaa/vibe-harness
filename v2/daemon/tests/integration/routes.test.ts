import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from '../../src/db/schema.js';
import { seed } from '../../src/db/seed.js';
import { join } from 'node:path';
import { rmSync, existsSync } from 'node:fs';

// We need to mock the DB module and auth module so routes use our test DB

const DB_PATH = join(process.cwd(), '.test-routes-db.sqlite');
const MIGRATIONS_DIR = join(process.cwd(), 'drizzle');

let sqlite: Database.Database;
let testDb: ReturnType<typeof drizzle<typeof schema>>;
let testToken: string;

// Mock getDb to return our test database
vi.mock('../../src/db/index.js', () => ({
  getDb: () => testDb,
  closeDb: () => {},
  getRawDb: () => sqlite,
}));

// Mock auth to use a fixed test token
testToken = 'test-token-for-routes';
vi.mock('../../src/lib/auth.js', async () => {
  const { createMiddleware } = await import('hono/factory');
  return {
    generateToken: () => testToken,
    getOrCreateToken: () => testToken,
    authMiddleware: () =>
      createMiddleware(async (c, next) => {
        // Skip auth for health
        if (c.req.path === '/health' || c.req.path === '/ws') {
          return next();
        }
        const authHeader = c.req.header('Authorization');
        if (!authHeader?.startsWith('Bearer ')) {
          return c.json({ error: 'Unauthorized' }, 401);
        }
        const provided = authHeader.slice('Bearer '.length);
        if (provided !== testToken) {
          return c.json({ error: 'Unauthorized' }, 401);
        }
        return next();
      }),
  };
});

// Mock shell.execCommand for project creation (git validation)
vi.mock('../../src/lib/shell.js', () => ({
  execCommand: async (cmd: string, args: string[]) => {
    // Simulate git checks succeeding for temp paths
    if (cmd === 'git' && args.includes('rev-parse')) {
      return { stdout: '.git\n', stderr: '', exitCode: 0 };
    }
    if (cmd === 'git' && args.includes('get-url')) {
      return { stdout: 'https://github.com/test/repo.git\n', stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: 'unknown', exitCode: 1 };
  },
}));

// Mock logger to silence output
vi.mock('../../src/lib/logger.js', () => ({
  logger: {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    child: () => ({
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    }),
  },
}));

// Mock existsSync for project creation path check
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    // Override only for the project routes path check
    existsSync: (p: string) => {
      if (typeof p === 'string' && p.startsWith('/test-project')) return true;
      return actual.existsSync(p);
    },
  };
});

// Now import the app (after mocks are set up)
const { default: app } = await import('../../src/app.js');

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${testToken}` };
}

function req(path: string, init?: RequestInit): Request {
  return new Request(`http://localhost${path}`, init);
}

beforeEach(() => {
  if (existsSync(DB_PATH)) rmSync(DB_PATH);
  if (existsSync(DB_PATH + '-wal')) rmSync(DB_PATH + '-wal');
  if (existsSync(DB_PATH + '-shm')) rmSync(DB_PATH + '-shm');

  sqlite = new Database(DB_PATH);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  testDb = drizzle(sqlite, { schema });
  migrate(testDb, { migrationsFolder: MIGRATIONS_DIR });
  seed(testDb);
});

afterEach(() => {
  sqlite.close();
  if (existsSync(DB_PATH)) rmSync(DB_PATH);
  if (existsSync(DB_PATH + '-wal')) rmSync(DB_PATH + '-wal');
  if (existsSync(DB_PATH + '-shm')) rmSync(DB_PATH + '-shm');
});

// ── Health ───────────────────────────────────────────────────────────

describe('GET /health', () => {
  it('returns 200 without auth', async () => {
    const res = await app.request(req('/health'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.service).toBe('vibe-harness-daemon');
  });
});

// ── Auth enforcement ────────────────────────────────────────────────

describe('Auth enforcement', () => {
  it('returns 401 on /api/projects without token', async () => {
    const res = await app.request(req('/api/projects'));
    expect(res.status).toBe(401);
  });

  it('returns 401 with wrong token', async () => {
    const res = await app.request(
      req('/api/projects', {
        headers: { Authorization: 'Bearer wrong-token' },
      }),
    );
    expect(res.status).toBe(401);
  });

  it('returns 401 on /api/agents without token', async () => {
    const res = await app.request(req('/api/agents'));
    expect(res.status).toBe(401);
  });

  it('returns 401 on /api/workflows without token', async () => {
    const res = await app.request(req('/api/workflows'));
    expect(res.status).toBe(401);
  });
});

// ── Projects ────────────────────────────────────────────────────────

describe('GET /api/projects', () => {
  it('returns 200 with empty array initially', async () => {
    const res = await app.request(
      req('/api/projects', { headers: authHeaders() }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.projects).toEqual([]);
  });
});

describe('POST /api/projects', () => {
  it('creates a project and returns 201', async () => {
    const res = await app.request(
      req('/api/projects', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Test Project',
          localPath: '/test-project-path',
        }),
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.name).toBe('Test Project');
    expect(body.localPath).toBe('/test-project-path');
    expect(body.id).toBeDefined();
  });

  it('returns 400 for missing required fields', async () => {
    const res = await app.request(
      req('/api/projects', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '' }),
      }),
    );
    expect(res.status).toBe(400);
  });
});

// ── Agents ──────────────────────────────────────────────────────────

describe('GET /api/agents', () => {
  it('returns seeded agent', async () => {
    const res = await app.request(
      req('/api/agents', { headers: authHeaders() }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.agents.length).toBeGreaterThanOrEqual(1);
    const copilot = body.agents.find((a: any) => a.name === 'Copilot CLI');
    expect(copilot).toBeDefined();
    expect(copilot.is_built_in || copilot.isBuiltIn).toBeTruthy();
  });
});

describe('POST /api/agents', () => {
  it('creates a custom agent', async () => {
    const res = await app.request(
      req('/api/agents', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Custom Agent',
          type: 'copilot_cli',
          commandTemplate: 'custom-cmd',
        }),
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.name).toBe('Custom Agent');
    expect(body.isBuiltIn).toBe(false);
  });
});

describe('PUT /api/agents/:id', () => {
  it('blocks modification of built-in agent', async () => {
    // Get the built-in agent
    const listRes = await app.request(
      req('/api/agents', { headers: authHeaders() }),
    );
    const agents = (await listRes.json()).agents;
    const builtIn = agents.find((a: any) => a.isBuiltIn === true || a.is_built_in === true);
    expect(builtIn).toBeDefined();

    const res = await app.request(
      req(`/api/agents/${builtIn.id}`, {
        method: 'PUT',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Hacked' }),
      }),
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('CONFLICT');
  });

  it('allows modification of custom agent', async () => {
    // Create a custom agent first
    const createRes = await app.request(
      req('/api/agents', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Editable',
          type: 'copilot_cli',
          commandTemplate: 'cmd',
        }),
      }),
    );
    const created = await createRes.json();

    const res = await app.request(
      req(`/api/agents/${created.id}`, {
        method: 'PUT',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated Name' }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe('Updated Name');
  });
});

// ── Workflows ───────────────────────────────────────────────────────

describe('GET /api/workflows', () => {
  it('returns seeded templates', async () => {
    const res = await app.request(
      req('/api/workflows', { headers: authHeaders() }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.templates.length).toBeGreaterThanOrEqual(3);

    const names = body.templates.map((t: any) => t.name);
    expect(names).toContain('Quick Run');
    expect(names).toContain('Plan & Implement');
    expect(names).toContain('Full Review');
  });

  it('includes parsed stages and stageCount', async () => {
    const res = await app.request(
      req('/api/workflows', { headers: authHeaders() }),
    );
    const body = await res.json();
    const quickRun = body.templates.find((t: any) => t.name === 'Quick Run');
    expect(quickRun.stages).toBeInstanceOf(Array);
    expect(quickRun.stageCount).toBe(1);

    const fullReview = body.templates.find((t: any) => t.name === 'Full Review');
    expect(fullReview.stageCount).toBe(5);
  });
});
