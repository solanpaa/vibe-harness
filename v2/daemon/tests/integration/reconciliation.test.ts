// ---------------------------------------------------------------------------
// Integration tests for startup reconciliation (reconcile.ts)
//
// Uses a real SQLite DB with Drizzle + migrations. Mocks:
//   - getDb/closeDb/getRawDb → point at in-memory test DB
//   - workflow/api resumeHook → vi.fn()
//   - logger → silent stubs
//   - sandboxService → injected mock (not module-level)
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

// ── Module mocks (hoisted by vitest) ─────────────────────────────────

vi.mock('../../src/db/index.js', () => ({
  getDb: () => testDb,
  closeDb: () => {},
  getRawDb: () => sqlite,
}));

const mockResumeHook = vi.fn().mockResolvedValue(undefined);

vi.mock('workflow/api', () => ({
  start: vi.fn(),
  resumeHook: (...args: any[]) => mockResumeHook(...args),
}));

vi.mock('../../src/lib/logger.js', () => {
  const noop: Record<string, any> = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  };
  noop.child = () => noop;
  return { logger: noop };
});

// Import after mocks
import { reconcileOnStartup, replayPendingHookResumes } from '../../src/lib/reconcile.js';
import type { SandboxService, SandboxInfo } from '../../src/services/sandbox.js';

// ── Helpers ──────────────────────────────────────────────────────────

let projectId: string;
let agentDefId: string;
let templateId: string;

function createMockSandboxService(
  liveSandboxes: SandboxInfo[] = [],
): SandboxService {
  return {
    create: vi.fn().mockResolvedValue('vibe-test'),
    getOrCreate: vi.fn().mockResolvedValue('vibe-test'),
    execInteractive: vi.fn(),
    execCommand: vi.fn(),
    getEnvVars: vi.fn().mockReturnValue({}),
    stop: vi.fn().mockResolvedValue(undefined),
    forceStop: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue(liveSandboxes),
    isActive: vi.fn().mockReturnValue(false),
    getSandboxName: vi.fn().mockImplementation((runId: string) => `vibe-${runId.slice(0, 12)}`),
    reconcileFromDocker: vi.fn().mockResolvedValue(undefined),
  } as unknown as SandboxService;
}

/** Insert a workflowRun and return its id. */
function insertRun(overrides: Partial<typeof schema.workflowRuns.$inferInsert> = {}): string {
  const run = testDb
    .insert(schema.workflowRuns)
    .values({
      workflowTemplateId: templateId,
      projectId,
      agentDefinitionId: agentDefId,
      description: 'reconciliation test',
      status: 'pending',
      ...overrides,
    })
    .returning()
    .get();
  return run.id;
}

/** Insert a stageExecution tied to a run. */
function insertStage(
  workflowRunId: string,
  overrides: Partial<typeof schema.stageExecutions.$inferInsert> = {},
): string {
  const se = testDb
    .insert(schema.stageExecutions)
    .values({
      workflowRunId,
      stageName: 'implement',
      round: 1,
      status: 'pending',
      ...overrides,
    })
    .returning()
    .get();
  return se.id;
}

// ── Setup / teardown ─────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();

  sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  testDb = drizzle(sqlite, { schema });
  migrate(testDb, { migrationsFolder: MIGRATIONS_DIR });
  seed(testDb);

  // Grab seed IDs for FK references
  const agent = testDb.select().from(schema.agentDefinitions).all()[0];
  const tmpl = testDb.select().from(schema.workflowTemplates).all()[0];
  const project = testDb
    .insert(schema.projects)
    .values({ name: 'Reconcile Test', localPath: '/fake/repo' })
    .returning()
    .get();

  agentDefId = agent.id;
  templateId = tmpl.id;
  projectId = project.id;
});

afterEach(() => {
  sqlite.close();
});

// ── Tests ────────────────────────────────────────────────────────────

describe('reconcileOnStartup', () => {
  it('marks running runs as stage_failed and sets failureReason on stage', async () => {
    const runId = insertRun({ status: 'running' });
    const stageId = insertStage(runId, { status: 'running' });

    const svc = createMockSandboxService();
    const result = await reconcileOnStartup(svc);

    const run = testDb
      .select()
      .from(schema.workflowRuns)
      .where(eq(schema.workflowRuns.id, runId))
      .get()!;
    expect(run.status).toBe('stage_failed');

    const stage = testDb
      .select()
      .from(schema.stageExecutions)
      .where(eq(schema.stageExecutions.id, stageId))
      .get()!;
    expect(stage.status).toBe('failed');
    expect(stage.failureReason).toBe('daemon_restart');
    expect(stage.completedAt).toBeTruthy();

    expect(result.runsReconciled).toBe(1);
  });

  it('does not touch completed or failed runs', async () => {
    const completedId = insertRun({ status: 'completed' });
    const failedId = insertRun({ status: 'failed' });
    const stageFailedId = insertRun({ status: 'stage_failed' });

    const svc = createMockSandboxService();
    await reconcileOnStartup(svc);

    for (const [id, expectedStatus] of [
      [completedId, 'completed'],
      [failedId, 'failed'],
      [stageFailedId, 'stage_failed'],
    ] as const) {
      const run = testDb
        .select()
        .from(schema.workflowRuns)
        .where(eq(schema.workflowRuns.id, id))
        .get()!;
      expect(run.status).toBe(expectedStatus);
    }
  });

  it('replays pending hookResumes and deletes the row', async () => {
    testDb
      .insert(schema.hookResumes)
      .values({
        hookToken: 'tok-abc',
        action: JSON.stringify({ type: 'approve', reviewId: 'r1' }),
      })
      .run();

    const svc = createMockSandboxService();
    const result = await reconcileOnStartup(svc);

    expect(mockResumeHook).toHaveBeenCalledOnce();
    expect(mockResumeHook).toHaveBeenCalledWith(
      'tok-abc',
      { type: 'approve', reviewId: 'r1' },
    );

    const remaining = testDb.select().from(schema.hookResumes).all();
    expect(remaining).toHaveLength(0);
    expect(result.hooksReplayed).toBe(1);
  });

  it('does not crash when resumeHook throws', async () => {
    testDb
      .insert(schema.hookResumes)
      .values({
        hookToken: 'tok-fail',
        action: JSON.stringify({ type: 'retry' }),
      })
      .run();

    mockResumeHook.mockRejectedValueOnce(new Error('network timeout'));

    const svc = createMockSandboxService();
    // Should NOT throw
    const result = await reconcileOnStartup(svc);

    // Row kept for retry on next startup
    const remaining = testDb.select().from(schema.hookResumes).all();
    expect(remaining).toHaveLength(1);
    expect(result.hooksReplayed).toBe(0);
  });

  it('reconciles multiple runs correctly (only running affected)', async () => {
    const runningId = insertRun({ status: 'running' });
    insertStage(runningId, { status: 'running' });

    const completedId = insertRun({ status: 'completed' });
    const failedId = insertRun({ status: 'failed' });

    const svc = createMockSandboxService();
    const result = await reconcileOnStartup(svc);

    expect(result.runsReconciled).toBe(1);

    const running = testDb
      .select()
      .from(schema.workflowRuns)
      .where(eq(schema.workflowRuns.id, runningId))
      .get()!;
    expect(running.status).toBe('stage_failed');

    const completed = testDb
      .select()
      .from(schema.workflowRuns)
      .where(eq(schema.workflowRuns.id, completedId))
      .get()!;
    expect(completed.status).toBe('completed');

    const failed = testDb
      .select()
      .from(schema.workflowRuns)
      .where(eq(schema.workflowRuns.id, failedId))
      .get()!;
    expect(failed.status).toBe('failed');
  });

  it('is idempotent — second call is a no-op', async () => {
    const runId = insertRun({ status: 'running' });
    insertStage(runId, { status: 'running' });

    const svc = createMockSandboxService();

    const first = await reconcileOnStartup(svc);
    expect(first.runsReconciled).toBe(1);

    // Second call: run is already stage_failed, nothing to reconcile
    const second = await reconcileOnStartup(svc);
    expect(second.runsReconciled).toBe(0);
    expect(second.sandboxesStopped).toBe(0);
    expect(second.hooksReplayed).toBe(0);
  });

  it('stops live sandboxes matching reconciled runs', async () => {
    const runId = insertRun({ status: 'running' });
    insertStage(runId, { status: 'running' });

    const sandboxName = `vibe-${runId.slice(0, 12)}`;
    const svc = createMockSandboxService([
      { name: sandboxName, status: 'running', image: 'test:latest', created: new Date().toISOString() },
    ]);

    const result = await reconcileOnStartup(svc);

    expect(svc.forceStop).toHaveBeenCalledWith(sandboxName);
    expect(result.sandboxesStopped).toBe(1);
  });

  it('stops orphaned sandboxes with no matching active run', async () => {
    // No active runs, but a sandbox is alive
    const svc = createMockSandboxService([
      { name: 'vibe-orphan12345', status: 'running', image: 'test:latest', created: new Date().toISOString() },
    ]);

    const result = await reconcileOnStartup(svc);

    expect(svc.forceStop).toHaveBeenCalledWith('vibe-orphan12345');
    expect(result.sandboxesStopped).toBe(1);
    expect(result.runsReconciled).toBe(0);
  });

  it('also reconciles provisioning runs', async () => {
    const runId = insertRun({ status: 'provisioning' });

    const svc = createMockSandboxService();
    const result = await reconcileOnStartup(svc);

    const run = testDb
      .select()
      .from(schema.workflowRuns)
      .where(eq(schema.workflowRuns.id, runId))
      .get()!;
    expect(run.status).toBe('stage_failed');
    expect(result.runsReconciled).toBe(1);
  });
});

describe('replayPendingHookResumes', () => {
  it('returns 0 when no pending resumes exist', async () => {
    const count = await replayPendingHookResumes();
    expect(count).toBe(0);
    expect(mockResumeHook).not.toHaveBeenCalled();
  });

  it('replays multiple pending resumes', async () => {
    testDb.insert(schema.hookResumes).values({
      hookToken: 'tok-1',
      action: JSON.stringify({ a: 1 }),
    }).run();
    testDb.insert(schema.hookResumes).values({
      hookToken: 'tok-2',
      action: JSON.stringify({ b: 2 }),
    }).run();

    const count = await replayPendingHookResumes();

    expect(count).toBe(2);
    expect(mockResumeHook).toHaveBeenCalledTimes(2);
    expect(testDb.select().from(schema.hookResumes).all()).toHaveLength(0);
  });
});
