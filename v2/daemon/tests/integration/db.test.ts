import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import * as schema from '../../src/db/schema.js';
import { seed } from '../../src/db/seed.js';
import { join } from 'node:path';
import { rmSync, existsSync } from 'node:fs';

// Each test uses a temp file DB (not :memory:) so WAL mode works
const DB_PATH = join(process.cwd(), '.test-db-temp.sqlite');
const MIGRATIONS_DIR = join(process.cwd(), 'drizzle');

let sqlite: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;

beforeEach(() => {
  // Clean up any previous test DB
  if (existsSync(DB_PATH)) rmSync(DB_PATH);
  if (existsSync(DB_PATH + '-wal')) rmSync(DB_PATH + '-wal');
  if (existsSync(DB_PATH + '-shm')) rmSync(DB_PATH + '-shm');

  sqlite = new Database(DB_PATH);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  seed(db);
});

afterEach(() => {
  sqlite.close();
  if (existsSync(DB_PATH)) rmSync(DB_PATH);
  if (existsSync(DB_PATH + '-wal')) rmSync(DB_PATH + '-wal');
  if (existsSync(DB_PATH + '-shm')) rmSync(DB_PATH + '-shm');
});

describe('Database schema', () => {
  it('creates all 17 tables', () => {
    const tables = sqlite
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%' ORDER BY name`,
      )
      .all() as { name: string }[];

    const tableNames = tables.map((t) => t.name).sort();
    expect(tableNames).toEqual([
      'agent_definitions',
      'credential_audit_log',
      'credential_entries',
      'credential_sets',
      'git_operations',
      'hook_resumes',
      'last_run_config',
      'parallel_groups',
      'projects',
      'proposals',
      'review_comments',
      'reviews',
      'run_messages',
      'settings',
      'stage_executions',
      'workflow_runs',
      'workflow_templates',
    ]);
  });

  it('has WAL mode active', () => {
    const result = sqlite.pragma('journal_mode') as { journal_mode: string }[];
    expect(result[0].journal_mode).toBe('wal');
  });
});

describe('Seed data', () => {
  it('inserts default Copilot CLI agent', () => {
    const agents = db.select().from(schema.agentDefinitions).all();
    expect(agents.length).toBeGreaterThanOrEqual(1);

    const copilot = agents.find((a) => a.name === 'Copilot CLI');
    expect(copilot).toBeDefined();
    expect(copilot!.type).toBe('copilot_cli');
    expect(copilot!.isBuiltIn).toBe(true);
  });

  it('inserts 3 workflow templates', () => {
    const templates = db.select().from(schema.workflowTemplates).all();
    expect(templates.length).toBeGreaterThanOrEqual(3);

    const names = templates.map((t) => t.name);
    expect(names).toContain('Quick Run');
    expect(names).toContain('Plan & Implement');
    expect(names).toContain('Full Review');
  });

  it('seed is idempotent — running twice does not duplicate', () => {
    seed(db);
    const agents = db.select().from(schema.agentDefinitions).all();
    const copilots = agents.filter((a) => a.name === 'Copilot CLI');
    expect(copilots).toHaveLength(1);
  });
});

describe('Foreign key constraints', () => {
  it('rejects workflow_run with invalid project_id', () => {
    const agents = db.select().from(schema.agentDefinitions).all();
    const templates = db.select().from(schema.workflowTemplates).all();

    expect(() => {
      db.insert(schema.workflowRuns)
        .values({
          workflowTemplateId: templates[0].id,
          projectId: 'non-existent-id',
          agentDefinitionId: agents[0].id,
          status: 'pending',
        })
        .run();
    }).toThrow(/FOREIGN KEY/i);
  });

  it('rejects workflow_run with invalid agent_definition_id', () => {
    const templates = db.select().from(schema.workflowTemplates).all();

    // Insert a real project first
    const project = db
      .insert(schema.projects)
      .values({ name: 'Test', localPath: '/fake' })
      .returning()
      .get();

    expect(() => {
      db.insert(schema.workflowRuns)
        .values({
          workflowTemplateId: templates[0].id,
          projectId: project.id,
          agentDefinitionId: 'non-existent-id',
          status: 'pending',
        })
        .run();
    }).toThrow(/FOREIGN KEY/i);
  });

  it('rejects review_comment with invalid review_id', () => {
    expect(() => {
      db.insert(schema.reviewComments)
        .values({
          reviewId: 'non-existent-id',
          body: 'test comment',
        })
        .run();
    }).toThrow(/FOREIGN KEY/i);
  });
});

describe('Unique constraints', () => {
  it('rejects duplicate stage execution (same run + stage + round)', () => {
    const agents = db.select().from(schema.agentDefinitions).all();
    const templates = db.select().from(schema.workflowTemplates).all();
    const project = db
      .insert(schema.projects)
      .values({ name: 'Test', localPath: '/fake' })
      .returning()
      .get();
    const run = db
      .insert(schema.workflowRuns)
      .values({
        workflowTemplateId: templates[0].id,
        projectId: project.id,
        agentDefinitionId: agents[0].id,
      })
      .returning()
      .get();

    // First insert succeeds
    db.insert(schema.stageExecutions)
      .values({ workflowRunId: run.id, stageName: 'plan', round: 1 })
      .run();

    // Duplicate should fail
    expect(() => {
      db.insert(schema.stageExecutions)
        .values({ workflowRunId: run.id, stageName: 'plan', round: 1 })
        .run();
    }).toThrow(/UNIQUE/i);
  });

  it('allows same stage name with different round number', () => {
    const agents = db.select().from(schema.agentDefinitions).all();
    const templates = db.select().from(schema.workflowTemplates).all();
    const project = db
      .insert(schema.projects)
      .values({ name: 'Test', localPath: '/fake' })
      .returning()
      .get();
    const run = db
      .insert(schema.workflowRuns)
      .values({
        workflowTemplateId: templates[0].id,
        projectId: project.id,
        agentDefinitionId: agents[0].id,
      })
      .returning()
      .get();

    db.insert(schema.stageExecutions)
      .values({ workflowRunId: run.id, stageName: 'plan', round: 1 })
      .run();
    // Different round → should succeed
    expect(() => {
      db.insert(schema.stageExecutions)
        .values({ workflowRunId: run.id, stageName: 'plan', round: 2 })
        .run();
    }).not.toThrow();
  });
});

describe('Cascade delete behavior', () => {
  it('deletes review_comments when parent review is deleted', () => {
    const agents = db.select().from(schema.agentDefinitions).all();
    const templates = db.select().from(schema.workflowTemplates).all();
    const project = db
      .insert(schema.projects)
      .values({ name: 'Test', localPath: '/fake' })
      .returning()
      .get();
    const run = db
      .insert(schema.workflowRuns)
      .values({
        workflowTemplateId: templates[0].id,
        projectId: project.id,
        agentDefinitionId: agents[0].id,
      })
      .returning()
      .get();
    const review = db
      .insert(schema.reviews)
      .values({ workflowRunId: run.id, stageName: 'plan', round: 1 })
      .returning()
      .get();
    db.insert(schema.reviewComments)
      .values({ reviewId: review.id, body: 'Fix this' })
      .run();

    // Verify comment exists
    const before = db.select().from(schema.reviewComments).all();
    expect(before.length).toBe(1);

    // Delete the review
    db.delete(schema.reviews).where(eq(schema.reviews.id, review.id)).run();

    // Comment should be cascade-deleted
    const after = db.select().from(schema.reviewComments).all();
    expect(after.length).toBe(0);
  });

  it('deletes run_messages when parent workflow_run is deleted', () => {
    const agents = db.select().from(schema.agentDefinitions).all();
    const templates = db.select().from(schema.workflowTemplates).all();
    const project = db
      .insert(schema.projects)
      .values({ name: 'Test', localPath: '/fake' })
      .returning()
      .get();
    const run = db
      .insert(schema.workflowRuns)
      .values({
        workflowTemplateId: templates[0].id,
        projectId: project.id,
        agentDefinitionId: agents[0].id,
      })
      .returning()
      .get();
    db.insert(schema.runMessages)
      .values({
        workflowRunId: run.id,
        stageName: 'plan',
        role: 'user',
        content: 'hello',
      })
      .run();

    const before = db.select().from(schema.runMessages).all();
    expect(before.length).toBe(1);

    db.delete(schema.workflowRuns).where(eq(schema.workflowRuns.id, run.id)).run();

    const after = db.select().from(schema.runMessages).all();
    expect(after.length).toBe(0);
  });
});

describe('JSON columns', () => {
  it('round-trips JSON in workflow template stages', () => {
    const stages = [
      { name: 'plan', promptTemplate: '{{description}}', reviewRequired: true },
      { name: 'implement', promptTemplate: '{{description}}', reviewRequired: false },
    ];

    const template = db
      .insert(schema.workflowTemplates)
      .values({
        name: 'JSON Test',
        stages: JSON.stringify(stages),
      })
      .returning()
      .get();

    const fetched = db
      .select()
      .from(schema.workflowTemplates)
      .where(eq(schema.workflowTemplates.id, template.id))
      .get()!;

    const parsed = JSON.parse(fetched.stages);
    expect(parsed).toEqual(stages);
    expect(parsed[0].name).toBe('plan');
    expect(parsed[1].reviewRequired).toBe(false);
  });

  it('round-trips JSON in run_messages metadata', () => {
    const agents = db.select().from(schema.agentDefinitions).all();
    const templates = db.select().from(schema.workflowTemplates).all();
    const project = db
      .insert(schema.projects)
      .values({ name: 'Test', localPath: '/fake' })
      .returning()
      .get();
    const run = db
      .insert(schema.workflowRuns)
      .values({
        workflowTemplateId: templates[0].id,
        projectId: project.id,
        agentDefinitionId: agents[0].id,
      })
      .returning()
      .get();

    const metadata = { toolCalls: ['read_file', 'write_file'], reasoning: 'test' };
    const msg = db
      .insert(schema.runMessages)
      .values({
        workflowRunId: run.id,
        stageName: 'plan',
        role: 'assistant',
        content: 'Hello',
        metadata: JSON.stringify(metadata),
      })
      .returning()
      .get();

    const fetched = db
      .select()
      .from(schema.runMessages)
      .where(eq(schema.runMessages.id, msg.id))
      .get()!;

    const parsed = JSON.parse(fetched.metadata!);
    expect(parsed).toEqual(metadata);
  });

  it('stores null metadata when field is omitted', () => {
    const agents = db.select().from(schema.agentDefinitions).all();
    const templates = db.select().from(schema.workflowTemplates).all();
    const project = db
      .insert(schema.projects)
      .values({ name: 'Test', localPath: '/fake' })
      .returning()
      .get();
    const run = db
      .insert(schema.workflowRuns)
      .values({
        workflowTemplateId: templates[0].id,
        projectId: project.id,
        agentDefinitionId: agents[0].id,
      })
      .returning()
      .get();
    const msg = db
      .insert(schema.runMessages)
      .values({
        workflowRunId: run.id,
        stageName: 'plan',
        role: 'user',
        content: 'test',
      })
      .returning()
      .get();

    expect(msg.metadata).toBeNull();
  });
});

describe('Default values', () => {
  it('workflow_run status defaults to pending', () => {
    const agents = db.select().from(schema.agentDefinitions).all();
    const templates = db.select().from(schema.workflowTemplates).all();
    const project = db
      .insert(schema.projects)
      .values({ name: 'Test', localPath: '/fake' })
      .returning()
      .get();
    const run = db
      .insert(schema.workflowRuns)
      .values({
        workflowTemplateId: templates[0].id,
        projectId: project.id,
        agentDefinitionId: agents[0].id,
      })
      .returning()
      .get();

    expect(run.status).toBe('pending');
  });

  it('auto-generates UUID primary keys', () => {
    const project = db
      .insert(schema.projects)
      .values({ name: 'Test', localPath: '/fake' })
      .returning()
      .get();
    // UUID v4 format
    expect(project.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('auto-generates createdAt timestamps', () => {
    const project = db
      .insert(schema.projects)
      .values({ name: 'Test', localPath: '/fake' })
      .returning()
      .get();
    // ISO 8601 format
    expect(new Date(project.createdAt).toISOString()).toBe(project.createdAt);
  });
});
