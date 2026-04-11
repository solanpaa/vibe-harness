// ---------------------------------------------------------------------------
// Integration tests for the workflow pipeline logic.
//
// Strategy: we test the step functions (executeStage, createReview, finalize)
// directly, injecting mocked deps and a real in-memory SQLite database.
// The pipeline.ts module uses "use workflow" which relies on the workflow
// runtime — we cannot call it directly. Instead we prove the building-blocks
// produce the right outcomes and the pipeline logic (tested indirectly
// through the step sequencing) is correct.
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

// Mock getDb to return our in-memory test database
vi.mock('../../src/db/index.js', () => ({
  getDb: () => testDb,
  closeDb: () => {},
  getRawDb: () => sqlite,
}));

// Silence logger
vi.mock('../../src/lib/logger.js', () => ({
  logger: {
    child: () => ({
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    }),
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  },
}));

// Import steps after mocks are in place
import { executeStage, type ExecuteStageOutput, type ExecuteStageDeps } from '../../src/workflows/steps/execute-stage.js';
import { createReview, type CreateReviewDeps } from '../../src/workflows/steps/create-review.js';
import { finalize, type FinalizeDeps } from '../../src/workflows/steps/finalize.js';
import type { SessionManager, StageResult } from '../../src/services/session-manager.js';
import type { ReviewService } from '../../src/services/review-service.js';
import type { WorktreeService } from '../../src/services/worktree.js';

// ── Test data ────────────────────────────────────────────────────────

let projectId: string;
let agentDefId: string;
let templateId: string;
let runId: string;

function createRunRecord(overrides: Record<string, any> = {}) {
  runId = crypto.randomUUID();
  testDb.insert(schema.workflowRuns).values({
    id: runId,
    workflowTemplateId: templateId,
    projectId,
    agentDefinitionId: agentDefId,
    description: 'Test task description',
    status: 'running',
    baseBranch: 'main',
    targetBranch: 'main',
    worktreePath: '/fake/worktree',
    branch: 'vibe-harness/test-branch',
    ...overrides,
  }).run();
  return runId;
}

// ── Mock factories ───────────────────────────────────────────────────

function mockSessionManager(overrides: Partial<SessionManager> = {}): SessionManager {
  return {
    create: vi.fn().mockResolvedValue(undefined),
    continue: vi.fn().mockResolvedValue(undefined),
    fresh: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    sendPrompt: vi.fn().mockResolvedValue(undefined),
    sendIntervention: vi.fn().mockResolvedValue(undefined),
    awaitCompletion: vi.fn().mockResolvedValue({
      status: 'completed',
      lastAssistantMessage: 'Done! I implemented the feature.',
      planMarkdown: null,
    } satisfies StageResult),
    isActive: vi.fn().mockReturnValue(true),
    ...overrides,
  };
}

function mockReviewService(overrides: Partial<ReviewService> = {}): ReviewService {
  return {
    createReview: vi.fn().mockImplementation(async (opts) => {
      const reviewId = crypto.randomUUID();
      testDb.insert(schema.reviews).values({
        id: reviewId,
        workflowRunId: opts.runId,
        stageName: opts.stageName,
        round: opts.round,
        type: opts.type,
        status: 'pending_review',
        diffSnapshot: 'diff --git a/file.ts\n+added line',
        aiSummary: 'Test summary',
      }).run();
      return { reviewId, alreadyExisted: false };
    }),
    bundleCommentsAsPrompt: vi.fn().mockResolvedValue({
      markdown: 'Fix the bugs',
      commentCount: 1,
    }),
    getDiff: vi.fn().mockResolvedValue({
      rawDiff: 'diff output',
      files: [],
      stats: { filesChanged: 1, insertions: 5, deletions: 2 },
    }),
    capturePlanMarkdown: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

function mockWorktreeService(overrides: Partial<WorktreeService> = {}): WorktreeService {
  return {
    create: vi.fn().mockResolvedValue({ worktreePath: '/fake/wt', branch: 'test-branch' }),
    remove: vi.fn().mockResolvedValue(undefined),
    getDiff: vi.fn().mockResolvedValue({
      rawDiff: 'diff',
      files: [],
      stats: { filesChanged: 1, insertions: 3, deletions: 1 },
    }),
    commitAll: vi.fn().mockResolvedValue({ committed: true, sha: 'abc123' }),
    rebase: vi.fn().mockResolvedValue({ success: true }),
    mergeBranch: vi.fn().mockResolvedValue({ success: true }),
    fastForwardMerge: vi.fn().mockResolvedValue(undefined),
    listBranches: vi.fn().mockResolvedValue(['main', 'test-branch']),
    exists: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

// ── Setup / Teardown ────────────────────────────────────────────────

beforeEach(() => {
  sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  testDb = drizzle(sqlite, { schema });
  migrate(testDb, { migrationsFolder: MIGRATIONS_DIR });
  seed(testDb);

  // Get seeded IDs
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
});

afterEach(() => {
  sqlite.close();
  vi.restoreAllMocks();
});

// ═══════════════════════════════════════════════════════════════════════
// executeStage tests
// ═══════════════════════════════════════════════════════════════════════

describe('executeStage', () => {
  it('happy path: executes stage and returns completed', async () => {
    createRunRecord();
    const sm = mockSessionManager();
    const deps: ExecuteStageDeps = {
      sessionManager: sm,
      reviewService: mockReviewService(),
    };

    const result = await executeStage({
      runId,
      stage: { name: 'implement', type: 'standard', promptTemplate: 'Do the thing.', freshSession: false },
      stageIndex: 0,
      round: 1,
      isFirstStage: true,
      previousResult: null,
      requestChangesComments: null,
    }, deps);

    expect(result.status).toBe('completed');
    expect(result.lastAssistantMessage).toBe('Done! I implemented the feature.');

    // Verify DB record created
    const exec = testDb.select().from(schema.stageExecutions)
      .where(eq(schema.stageExecutions.workflowRunId, runId))
      .get();
    expect(exec).toBeDefined();
    expect(exec!.status).toBe('completed');
    expect(exec!.stageName).toBe('implement');
  });

  it('idempotent: returns cached result for already completed stage', async () => {
    createRunRecord();
    const execId = crypto.randomUUID();
    testDb.insert(schema.stageExecutions).values({
      id: execId,
      workflowRunId: runId,
      stageName: 'plan',
      round: 1,
      status: 'completed',
    }).run();
    // Insert a message so the cached lookup finds it
    testDb.insert(schema.runMessages).values({
      workflowRunId: runId,
      stageName: 'plan',
      round: 1,
      role: 'assistant',
      content: 'Cached plan output',
      isIntervention: false,
    }).run();

    const sm = mockSessionManager();
    const result = await executeStage({
      runId,
      stage: { name: 'plan', type: 'standard', promptTemplate: 'Plan.', freshSession: false },
      stageIndex: 0,
      round: 1,
      isFirstStage: true,
      previousResult: null,
      requestChangesComments: null,
    }, { sessionManager: sm, reviewService: mockReviewService() });

    expect(result.status).toBe('completed');
    expect(result.lastAssistantMessage).toBe('Cached plan output');
    // Session manager should NOT have been called
    expect(sm.sendPrompt).not.toHaveBeenCalled();
    expect(sm.awaitCompletion).not.toHaveBeenCalled();
  });

  it('stage failure: returns failed status with error', async () => {
    createRunRecord();
    const sm = mockSessionManager({
      awaitCompletion: vi.fn().mockResolvedValue({
        status: 'failed',
        lastAssistantMessage: null,
        planMarkdown: null,
        error: 'Agent crashed',
      } satisfies StageResult),
    });

    const result = await executeStage({
      runId,
      stage: { name: 'implement', type: 'standard', promptTemplate: 'Do it.', freshSession: false },
      stageIndex: 0,
      round: 1,
      isFirstStage: true,
      previousResult: null,
      requestChangesComments: null,
    }, { sessionManager: sm, reviewService: mockReviewService() });

    expect(result.status).toBe('failed');
    expect(result.error).toBe('Agent crashed');

    const exec = testDb.select().from(schema.stageExecutions)
      .where(eq(schema.stageExecutions.workflowRunId, runId))
      .get();
    expect(exec!.status).toBe('failed');
    expect(exec!.failureReason).toBe('Agent crashed');
  });

  it('retry: builds retry prompt with error info', async () => {
    createRunRecord();
    const sm = mockSessionManager();
    const deps: ExecuteStageDeps = {
      sessionManager: sm,
      reviewService: mockReviewService(),
    };

    await executeStage({
      runId,
      stage: { name: 'implement', type: 'standard', promptTemplate: 'Do it.', freshSession: false },
      stageIndex: 0,
      round: 2,
      isFirstStage: false,
      previousResult: null,
      requestChangesComments: null,
      retryError: 'Process exited with code 1',
    }, deps);

    // The prompt sent should contain the retry error
    const sentPrompt = (sm.sendPrompt as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(sentPrompt).toContain('Retry Required');
    expect(sentPrompt).toContain('Process exited with code 1');
  });

  it('request changes: builds prompt with bundled comments', async () => {
    createRunRecord();
    const sm = mockSessionManager();

    await executeStage({
      runId,
      stage: { name: 'implement', type: 'standard', promptTemplate: 'Do it.', freshSession: false },
      stageIndex: 0,
      round: 2,
      isFirstStage: false,
      previousResult: null,
      requestChangesComments: [
        { body: 'Fix auth logic', filePath: 'src/auth.ts', lineNumber: 42 },
        { body: 'Add tests', filePath: null },
      ],
    }, { sessionManager: sm, reviewService: mockReviewService() });

    const sentPrompt = (sm.sendPrompt as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(sentPrompt).toContain('Changes Requested');
    expect(sentPrompt).toContain('Fix auth logic');
    expect(sentPrompt).toContain('Add tests');
  });

  it('model override: stage model passed through to session', async () => {
    createRunRecord({ model: 'gpt-4o' });
    const sm = mockSessionManager();

    await executeStage({
      runId,
      stage: {
        name: 'implement',
        type: 'standard',
        promptTemplate: 'Do it.',
        freshSession: false,
        model: 'claude-sonnet',
      },
      stageIndex: 1,
      round: 1,
      isFirstStage: false,
      previousResult: null,
      requestChangesComments: null,
    }, { sessionManager: sm, reviewService: mockReviewService() });

    // Should call continue with stage-level model (overrides run model)
    expect(sm.continue).toHaveBeenCalledWith(runId, { model: 'claude-sonnet' });
  });

  it('freshSession: calls sessionManager.fresh with context', async () => {
    createRunRecord();
    const sm = mockSessionManager();

    // Insert a "completed" prior stage for context building
    testDb.insert(schema.stageExecutions).values({
      workflowRunId: runId,
      stageName: 'plan',
      round: 1,
      status: 'completed',
    }).run();
    testDb.insert(schema.runMessages).values({
      workflowRunId: runId,
      stageName: 'plan',
      round: 1,
      role: 'assistant',
      content: 'Here is the plan...',
      isIntervention: false,
    }).run();

    await executeStage({
      runId,
      stage: { name: 'review', type: 'standard', promptTemplate: 'Review.', freshSession: true },
      stageIndex: 1,
      round: 1,
      isFirstStage: false,
      previousResult: { lastAssistantMessage: 'Previous output', planMarkdown: null },
      requestChangesComments: null,
    }, { sessionManager: sm, reviewService: mockReviewService() });

    expect(sm.fresh).toHaveBeenCalledOnce();
    // First arg is runId, second is context object
    const freshCall = (sm.fresh as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(freshCall[0]).toBe(runId);
    expect(freshCall[1].summary).toContain('plan');
  });

  it('resume after crash: already-running stage re-attaches if session active', async () => {
    createRunRecord();
    const execId = crypto.randomUUID();
    testDb.insert(schema.stageExecutions).values({
      id: execId,
      workflowRunId: runId,
      stageName: 'implement',
      round: 1,
      status: 'running',
    }).run();

    const sm = mockSessionManager({
      isActive: vi.fn().mockReturnValue(true),
      awaitCompletion: vi.fn().mockResolvedValue({
        status: 'completed',
        lastAssistantMessage: 'Resumed output',
        planMarkdown: null,
      } satisfies StageResult),
    });

    const result = await executeStage({
      runId,
      stage: { name: 'implement', type: 'standard', promptTemplate: 'Do it.', freshSession: false },
      stageIndex: 0,
      round: 1,
      isFirstStage: false,
      previousResult: null,
      requestChangesComments: null,
    }, { sessionManager: sm, reviewService: mockReviewService() });

    expect(result.status).toBe('completed');
    expect(result.lastAssistantMessage).toBe('Resumed output');
    // Should NOT have sent a new prompt (resumed existing)
    expect(sm.sendPrompt).not.toHaveBeenCalled();
  });

  it('resume after crash: marks failed if session not active', async () => {
    createRunRecord();
    const execId = crypto.randomUUID();
    testDb.insert(schema.stageExecutions).values({
      id: execId,
      workflowRunId: runId,
      stageName: 'implement',
      round: 1,
      status: 'running',
    }).run();

    const sm = mockSessionManager({
      isActive: vi.fn().mockReturnValue(false),
    });

    const result = await executeStage({
      runId,
      stage: { name: 'implement', type: 'standard', promptTemplate: 'Do it.', freshSession: false },
      stageIndex: 0,
      round: 1,
      isFirstStage: false,
      previousResult: null,
      requestChangesComments: null,
    }, { sessionManager: sm, reviewService: mockReviewService() });

    expect(result.status).toBe('failed');
    expect(result.error).toContain('daemon_restart');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// createReview tests
// ═══════════════════════════════════════════════════════════════════════

describe('createReview', () => {
  it('creates a review record with diff snapshot', async () => {
    createRunRecord();
    const rs = mockReviewService();

    const result = await createReview({
      runId,
      stageName: 'implement',
      round: 1,
      type: 'stage',
      lastAssistantMessage: 'Done',
      planMarkdown: null,
    }, { reviewService: rs });

    expect(result.id).toBeDefined();
    expect(rs.createReview).toHaveBeenCalledOnce();

    // Verify review in DB
    const review = testDb.select().from(schema.reviews)
      .where(eq(schema.reviews.id, result.id))
      .get();
    expect(review).toBeDefined();
    expect(review!.status).toBe('pending_review');
  });

  it('idempotent: returns cached review for same run+stage+round+type', async () => {
    createRunRecord();
    const existingId = crypto.randomUUID();
    testDb.insert(schema.reviews).values({
      id: existingId,
      workflowRunId: runId,
      stageName: 'implement',
      round: 1,
      type: 'stage',
      status: 'pending_review',
      diffSnapshot: 'old diff',
      aiSummary: 'old summary',
    }).run();

    const rs = mockReviewService();
    const result = await createReview({
      runId,
      stageName: 'implement',
      round: 1,
      type: 'stage',
      lastAssistantMessage: null,
      planMarkdown: null,
    }, { reviewService: rs });

    expect(result.id).toBe(existingId);
    // reviewService.createReview should NOT have been called
    expect(rs.createReview).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// finalize tests
// ═══════════════════════════════════════════════════════════════════════

describe('finalize', () => {
  function makeDeps(overrides: {
    wt?: Partial<WorktreeService>;
    sm?: Partial<SessionManager>;
  } = {}): FinalizeDeps {
    return {
      worktreeService: mockWorktreeService(overrides.wt),
      sessionManager: mockSessionManager(overrides.sm),
    };
  }

  it('happy path: commit → rebase → merge → cleanup → done', async () => {
    createRunRecord();
    const deps = makeDeps();

    const result = await finalize({ runId, targetBranch: 'main' }, deps);

    expect(result.conflict).toBe(false);
    expect(deps.worktreeService.commitAll).toHaveBeenCalledOnce();
    expect(deps.worktreeService.rebase).toHaveBeenCalledOnce();
    expect(deps.worktreeService.fastForwardMerge).toHaveBeenCalledOnce();
    expect(deps.worktreeService.remove).toHaveBeenCalledOnce();
    expect(deps.sessionManager.stop).toHaveBeenCalledOnce();

    // Journal should be marked done
    const journal = testDb.select().from(schema.gitOperations)
      .where(eq(schema.gitOperations.workflowRunId, runId))
      .get();
    expect(journal!.phase).toBe('done');

    // Run should have cleared references
    const run = testDb.select().from(schema.workflowRuns)
      .where(eq(schema.workflowRuns.id, runId))
      .get();
    expect(run!.sandboxId).toBeNull();
    expect(run!.worktreePath).toBeNull();
    expect(run!.completedAt).toBeDefined();
  });

  it('rebase conflict: returns conflict=true without merging', async () => {
    createRunRecord();
    const deps = makeDeps({
      wt: {
        rebase: vi.fn().mockResolvedValue({ success: false, conflictFiles: ['src/main.ts'] }),
      },
    });

    const result = await finalize({ runId, targetBranch: 'main' }, deps);

    expect(result.conflict).toBe(true);
    // Should NOT have proceeded to merge
    expect(deps.worktreeService.fastForwardMerge).not.toHaveBeenCalled();
    expect(deps.worktreeService.remove).not.toHaveBeenCalled();
  });

  it('idempotent: already-done finalization returns immediately', async () => {
    createRunRecord();
    // Pre-create a done journal entry
    testDb.insert(schema.gitOperations).values({
      id: crypto.randomUUID(),
      type: 'finalize',
      workflowRunId: runId,
      phase: 'done',
      metadata: JSON.stringify({ targetBranch: 'main' }),
    }).run();

    const deps = makeDeps();
    const result = await finalize({ runId, targetBranch: 'main' }, deps);

    expect(result.conflict).toBe(false);
    // Nothing should have been called
    expect(deps.worktreeService.commitAll).not.toHaveBeenCalled();
    expect(deps.worktreeService.rebase).not.toHaveBeenCalled();
  });

  it('stop session failure is swallowed during cleanup', async () => {
    createRunRecord();
    const deps = makeDeps({
      sm: { stop: vi.fn().mockRejectedValue(new Error('sandbox gone')) },
    });

    // Should not throw despite stop() failing
    const result = await finalize({ runId, targetBranch: 'main' }, deps);
    expect(result.conflict).toBe(false);
  });
});
