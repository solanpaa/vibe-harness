// ---------------------------------------------------------------------------
// Unit tests for consolidate and consolidate-finish steps.
//
// Uses a real in-memory SQLite DB. Mocks: worktreeService, sessionManager.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq, and } from 'drizzle-orm';
import * as schema from '../../src/db/schema.js';
import { seed } from '../../src/db/seed.js';
import { join } from 'node:path';

const MIGRATIONS_DIR = join(process.cwd(), 'drizzle');

let sqlite: Database.Database;
let testDb: ReturnType<typeof drizzle<typeof schema>>;

// ── Module mocks ─────────────────────────────────────────────────────

vi.mock('../../src/db/index.js', () => ({
  getDb: () => testDb,
  closeDb: () => {},
  getRawDb: () => sqlite,
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
import { consolidate, type ConsolidateDeps } from '../../src/workflows/steps/consolidate.js';
import { consolidateFinish, type ConsolidateFinishDeps } from '../../src/workflows/steps/consolidate-finish.js';
import type { WorktreeService } from '../../src/services/worktree.js';
import type { SessionManager } from '../../src/services/session-manager.js';

// ── Helpers ──────────────────────────────────────────────────────────

let projectId: string;
let agentDefId: string;
let templateId: string;

function createMockWorktreeService(overrides: Partial<WorktreeService> = {}): WorktreeService {
  return {
    create: vi.fn(),
    remove: vi.fn().mockResolvedValue(undefined),
    getDiff: vi.fn().mockResolvedValue({
      rawDiff: '',
      files: [],
      stats: { filesChanged: 3, insertions: 50, deletions: 10 },
    }),
    commitAll: vi.fn().mockResolvedValue({ committed: true, sha: 'abc123' }),
    rebase: vi.fn(),
    mergeBranch: vi.fn().mockResolvedValue({ success: true }),
    fastForwardMerge: vi.fn().mockResolvedValue(undefined),
    checkoutNewBranch: vi.fn().mockResolvedValue(undefined),
    isAncestor: vi.fn().mockResolvedValue(false),
    listBranches: vi.fn(),
    exists: vi.fn(),
    ...overrides,
  } as unknown as WorktreeService;
}

function createMockSessionManager(): SessionManager {
  return {
    stop: vi.fn().mockResolvedValue(undefined),
  } as unknown as SessionManager;
}

function insertRun(overrides: Partial<typeof schema.workflowRuns.$inferInsert> = {}): string {
  const run = testDb
    .insert(schema.workflowRuns)
    .values({
      workflowTemplateId: templateId,
      projectId,
      agentDefinitionId: agentDefId,
      description: 'consolidate test',
      status: 'running',
      worktreePath: '/fake/worktree',
      branch: 'vibe-harness/parent-branch',
      ...overrides,
    })
    .returning()
    .get();
  return run.id;
}

function insertChildRun(
  parallelGroupId: string,
  overrides: Partial<typeof schema.workflowRuns.$inferInsert> = {},
): string {
  const run = testDb
    .insert(schema.workflowRuns)
    .values({
      workflowTemplateId: templateId,
      projectId,
      agentDefinitionId: agentDefId,
      description: 'child run',
      status: 'completed',
      worktreePath: '/fake/child-worktree',
      branch: `vibe-harness/child-${crypto.randomUUID().slice(0, 8)}`,
      parallelGroupId,
      ...overrides,
    })
    .returning()
    .get();
  return run.id;
}

function insertParallelGroup(sourceRunId: string): string {
  const pg = testDb
    .insert(schema.parallelGroups)
    .values({
      sourceWorkflowRunId: sourceRunId,
      name: 'Test group',
      status: 'running',
    })
    .returning()
    .get();
  return pg.id;
}

function insertProposal(
  workflowRunId: string,
  parallelGroupId: string,
  childRunId: string,
  sortOrder: number,
): void {
  testDb
    .insert(schema.proposals)
    .values({
      workflowRunId,
      stageName: 'split',
      parallelGroupId,
      title: `Proposal ${sortOrder}`,
      description: 'test',
      affectedFiles: '[]',
      dependsOn: '[]',
      status: 'approved',
      launchedWorkflowRunId: childRunId,
      sortOrder,
    })
    .run();
}

// ── Setup / teardown ─────────────────────────────────────────────────

beforeEach(() => {
  sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  testDb = drizzle(sqlite, { schema });
  migrate(testDb, { migrationsFolder: MIGRATIONS_DIR });
  seed(testDb);

  const agent = testDb.select().from(schema.agentDefinitions).all()[0];
  const tmpl = testDb.select().from(schema.workflowTemplates).all()[0];
  const project = testDb
    .insert(schema.projects)
    .values({ name: 'Consolidate Test', localPath: '/fake/repo' })
    .returning()
    .get();

  agentDefId = agent.id;
  templateId = tmpl.id;
  projectId = project.id;
});

afterEach(() => {
  sqlite.close();
});

// ── consolidate step ─────────────────────────────────────────────────

describe('consolidate', () => {
  it('creates a git journal entry', async () => {
    const parentId = insertRun();
    const pgId = insertParallelGroup(parentId);
    const childId = insertChildRun(pgId);
    insertProposal(parentId, pgId, childId, 0);

    const wt = createMockWorktreeService();
    await consolidate({ parentRunId: parentId, parallelGroupId: pgId }, { worktreeService: wt });

    const journal = testDb
      .select()
      .from(schema.gitOperations)
      .where(
        and(
          eq(schema.gitOperations.workflowRunId, parentId),
          eq(schema.gitOperations.type, 'consolidate'),
        ),
      )
      .get();

    expect(journal).toBeTruthy();
    expect(journal!.phase).toBe('merged');
    const meta = JSON.parse(journal!.metadata ?? '{}');
    expect(meta.consolidationBranch).toContain('vibe-harness/consolidate-');
    expect(meta.mergedChildren).toContain(childId);
  });

  it('merges children in sortOrder', async () => {
    const parentId = insertRun();
    const pgId = insertParallelGroup(parentId);
    const childA = insertChildRun(pgId, { branch: 'vibe-harness/child-a' });
    const childB = insertChildRun(pgId, { branch: 'vibe-harness/child-b' });

    // B has sortOrder 0, A has sortOrder 1 → B merged first
    insertProposal(parentId, pgId, childB, 0);
    insertProposal(parentId, pgId, childA, 1);

    const mergeCalls: string[] = [];
    const wt = createMockWorktreeService({
      mergeBranch: vi.fn().mockImplementation(
        async (_pp: string, _wp: string, sourceBranch: string) => {
          mergeCalls.push(sourceBranch);
          return { success: true };
        },
      ),
    });

    await consolidate({ parentRunId: parentId, parallelGroupId: pgId }, { worktreeService: wt });

    expect(mergeCalls).toEqual(['vibe-harness/child-b', 'vibe-harness/child-a']);
  });

  it('handles merge conflict and returns conflict info', async () => {
    const parentId = insertRun();
    const pgId = insertParallelGroup(parentId);
    const childId = insertChildRun(pgId, { branch: 'vibe-harness/child-conflict' });
    insertProposal(parentId, pgId, childId, 0);

    const wt = createMockWorktreeService({
      mergeBranch: vi.fn().mockResolvedValue({
        success: false,
        conflictFiles: ['src/main.ts'],
      }),
    });

    const result = await consolidate(
      { parentRunId: parentId, parallelGroupId: pgId },
      { worktreeService: wt },
    );

    expect(result.conflict).toBe(true);
    expect(result.conflictChildId).toBe(childId);
  });

  it('is idempotent — re-running a completed merge is a no-op', async () => {
    const parentId = insertRun();
    const pgId = insertParallelGroup(parentId);
    const childId = insertChildRun(pgId);
    insertProposal(parentId, pgId, childId, 0);

    const wt = createMockWorktreeService();

    // First run
    await consolidate({ parentRunId: parentId, parallelGroupId: pgId }, { worktreeService: wt });

    // Second run — should not call mergeBranch again
    const wt2 = createMockWorktreeService();
    const result = await consolidate(
      { parentRunId: parentId, parallelGroupId: pgId },
      { worktreeService: wt2 },
    );

    expect(result.conflict).toBe(false);
    expect(wt2.mergeBranch).not.toHaveBeenCalled();
    expect(wt2.commitAll).not.toHaveBeenCalled();
  });

  it('returns mergedFiles summary', async () => {
    const parentId = insertRun();
    const pgId = insertParallelGroup(parentId);
    const childId = insertChildRun(pgId);
    insertProposal(parentId, pgId, childId, 0);

    const wt = createMockWorktreeService();
    const result = await consolidate(
      { parentRunId: parentId, parallelGroupId: pgId },
      { worktreeService: wt },
    );

    expect(result.mergedFiles).toContain('3 files changed');
  });
});

// ── consolidate-finish step ──────────────────────────────────────────

describe('consolidateFinish', () => {
  it('performs ff_parent and cleanup', async () => {
    const parentId = insertRun();
    const pgId = insertParallelGroup(parentId);
    const childId = insertChildRun(pgId, { branch: 'vibe-harness/child-done' });
    insertProposal(parentId, pgId, childId, 0);

    // Set up journal at 'merged' phase (as consolidate would leave it)
    testDb
      .insert(schema.gitOperations)
      .values({
        type: 'consolidate',
        workflowRunId: parentId,
        parallelGroupId: pgId,
        phase: 'merged',
        metadata: JSON.stringify({
          consolidationBranch: `vibe-harness/consolidate-${parentId.slice(0, 8)}`,
          mergeOrder: [childId],
          mergedChildren: [childId],
          conflictChild: null,
        }),
      })
      .run();

    const wt = createMockWorktreeService();
    const sm = createMockSessionManager();

    await consolidateFinish(
      { parentRunId: parentId, parallelGroupId: pgId },
      { worktreeService: wt, sessionManager: sm },
    );

    // Journal should be at 'done'
    const journal = testDb
      .select()
      .from(schema.gitOperations)
      .where(
        and(
          eq(schema.gitOperations.workflowRunId, parentId),
          eq(schema.gitOperations.type, 'consolidate'),
        ),
      )
      .get();
    expect(journal!.phase).toBe('done');

    // ff merge should have been called
    expect(wt.fastForwardMerge).toHaveBeenCalledOnce();

    // Child worktree should have been removed
    expect(wt.remove).toHaveBeenCalled();

    // Child session should have been stopped
    expect(sm.stop).toHaveBeenCalledWith(childId);

    // Parallel group should be completed
    const pg = testDb
      .select()
      .from(schema.parallelGroups)
      .where(eq(schema.parallelGroups.id, pgId))
      .get();
    expect(pg!.status).toBe('completed');
  });

  it('is idempotent — re-running a done journal is a no-op', async () => {
    const parentId = insertRun();
    const pgId = insertParallelGroup(parentId);

    testDb
      .insert(schema.gitOperations)
      .values({
        type: 'consolidate',
        workflowRunId: parentId,
        parallelGroupId: pgId,
        phase: 'done',
        metadata: JSON.stringify({
          consolidationBranch: 'vibe-harness/consolidate-x',
          mergeOrder: [],
          mergedChildren: [],
          conflictChild: null,
        }),
      })
      .run();

    const wt = createMockWorktreeService();
    const sm = createMockSessionManager();

    // Should not throw, should not call any service methods
    await consolidateFinish(
      { parentRunId: parentId, parallelGroupId: pgId },
      { worktreeService: wt, sessionManager: sm },
    );

    expect(wt.fastForwardMerge).not.toHaveBeenCalled();
    expect(wt.remove).not.toHaveBeenCalled();
    expect(sm.stop).not.toHaveBeenCalled();
  });

  it('throws when journal is missing', async () => {
    const parentId = insertRun();
    const pgId = insertParallelGroup(parentId);

    const wt = createMockWorktreeService();
    const sm = createMockSessionManager();

    await expect(
      consolidateFinish(
        { parentRunId: parentId, parallelGroupId: pgId },
        { worktreeService: wt, sessionManager: sm },
      ),
    ).rejects.toThrow(/No consolidation journal/);
  });

  it('throws when journal is in unexpected phase', async () => {
    const parentId = insertRun();
    const pgId = insertParallelGroup(parentId);

    testDb
      .insert(schema.gitOperations)
      .values({
        type: 'consolidate',
        workflowRunId: parentId,
        parallelGroupId: pgId,
        phase: 'snapshot_parent',
        metadata: '{}',
      })
      .run();

    const wt = createMockWorktreeService();
    const sm = createMockSessionManager();

    await expect(
      consolidateFinish(
        { parentRunId: parentId, parallelGroupId: pgId },
        { worktreeService: wt, sessionManager: sm },
      ),
    ).rejects.toThrow(/Unexpected journal phase/);
  });
});
