/**
 * Drizzle ORM + better-sqlite3 + WAL mode validation script.
 * Exercises: table creation, FK enforcement, UNIQUE constraints,
 * JSON column round-trip, WAL mode verification, and basic CRUD.
 */

import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { getDb, closeDb, getRawDb } from './index.js';
import { projects, workflowTemplates, workflowRuns, stageExecutions } from './schema.js';
import fs from 'node:fs';

const DB_PATH = './test-vibe-harness.db';

// Clean up any previous test DB
if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
if (fs.existsSync(DB_PATH + '-wal')) fs.unlinkSync(DB_PATH + '-wal');
if (fs.existsSync(DB_PATH + '-shm')) fs.unlinkSync(DB_PATH + '-shm');

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.error(`  ❌ ${label}`);
    failed++;
  }
}

try {
  const db = getDb(DB_PATH);
  const raw = getRawDb()!;

  // ── 1. WAL mode ────────────────────────────────────────────────────
  console.log('\n── WAL Mode ──');
  const journalMode = raw.pragma('journal_mode', { simple: true }) as string;
  assert(journalMode === 'wal', `journal_mode = '${journalMode}' (expected 'wal')`);

  // ── 2. Foreign keys enabled ────────────────────────────────────────
  console.log('\n── Foreign Keys ──');
  const fkEnabled = raw.pragma('foreign_keys', { simple: true });
  assert(fkEnabled === 1, `foreign_keys = ${fkEnabled} (expected 1)`);

  // ── 3. Apply migrations ────────────────────────────────────────────
  console.log('\n── Migrations ──');
  migrate(db, { migrationsFolder: './drizzle' });
  assert(true, 'Migrations applied successfully');

  // ── 4. INSERT — projects ───────────────────────────────────────────
  console.log('\n── INSERT projects ──');
  const proj = db.insert(projects).values({
    name: 'test-project',
    localPath: '/home/user/project',
    description: 'A test project',
  }).returning().get();
  assert(!!proj.id, `Project created with id=${proj.id.slice(0, 8)}…`);
  assert(!!proj.createdAt, `createdAt default populated: ${proj.createdAt}`);

  // ── 5. INSERT — workflowTemplates with JSON column ─────────────────
  console.log('\n── INSERT workflowTemplates (JSON column) ──');
  const stagesJson = JSON.stringify([
    { name: 'plan', prompt: 'Create a plan', agentId: null },
    { name: 'implement', prompt: 'Implement the plan', agentId: null },
    { name: 'review', prompt: 'Review the code', agentId: null },
  ]);
  const tmpl = db.insert(workflowTemplates).values({
    name: 'plan-implement-review',
    description: 'Standard 3-stage workflow',
    stages: stagesJson,
    isBuiltIn: true,
  }).returning().get();
  assert(!!tmpl.id, `Template created with id=${tmpl.id.slice(0, 8)}…`);

  // ── 6. JSON round-trip ─────────────────────────────────────────────
  console.log('\n── JSON round-trip ──');
  const readTmpl = db.select().from(workflowTemplates).where(eq(workflowTemplates.id, tmpl.id)).get()!;
  const parsedStages = JSON.parse(readTmpl.stages);
  assert(Array.isArray(parsedStages) && parsedStages.length === 3, `Stages JSON round-trip: ${parsedStages.length} stages`);
  assert(parsedStages[0].name === 'plan', `First stage name = '${parsedStages[0].name}'`);

  // ── 7. INSERT — workflowRuns (FK to projects + templates) ──────────
  console.log('\n── INSERT workflowRuns (FK validation) ──');
  const run = db.insert(workflowRuns).values({
    workflowTemplateId: tmpl.id,
    projectId: proj.id,
    description: 'Test run',
    status: 'running',
  }).returning().get();
  assert(!!run.id, `WorkflowRun created with id=${run.id.slice(0, 8)}…`);

  // ── 8. FK constraint enforcement — invalid FK should fail ──────────
  console.log('\n── FK constraint enforcement ──');
  let fkViolated = false;
  try {
    db.insert(workflowRuns).values({
      workflowTemplateId: 'nonexistent-template-id',
      projectId: proj.id,
      description: 'Should fail',
    }).run();
  } catch (e: any) {
    fkViolated = true;
    assert(e.message.includes('FOREIGN KEY'), `FK violation error: ${e.message.slice(0, 60)}`);
  }
  assert(fkViolated, 'FK constraint prevented invalid insert');

  // ── 9. INSERT — stageExecutions (FK to workflowRuns) ───────────────
  console.log('\n── INSERT stageExecutions ──');
  const usageStatsJson = JSON.stringify({ durationMs: 12345, tokensIn: 500, tokensOut: 1200 });
  const stage = db.insert(stageExecutions).values({
    workflowRunId: run.id,
    stageName: 'plan',
    round: 1,
    status: 'completed',
    prompt: 'Create a plan for the task',
    usageStats: usageStatsJson,
  }).returning().get();
  assert(!!stage.id, `StageExecution created with id=${stage.id.slice(0, 8)}…`);

  // ── 10. UNIQUE constraint enforcement ──────────────────────────────
  console.log('\n── UNIQUE constraint enforcement ──');
  let uniqueViolated = false;
  try {
    db.insert(stageExecutions).values({
      workflowRunId: run.id,
      stageName: 'plan',
      round: 1,  // Duplicate (runId, stageName, round)
      status: 'pending',
    }).run();
  } catch (e: any) {
    uniqueViolated = true;
    assert(e.message.includes('UNIQUE'), `UNIQUE violation error: ${e.message.slice(0, 60)}`);
  }
  assert(uniqueViolated, 'UNIQUE constraint prevented duplicate stage execution');

  // ── 11. UNIQUE allows different round ──────────────────────────────
  console.log('\n── UNIQUE allows different round ──');
  const stage2 = db.insert(stageExecutions).values({
    workflowRunId: run.id,
    stageName: 'plan',
    round: 2,  // Different round — should succeed
    status: 'pending',
  }).returning().get();
  assert(!!stage2.id, `Round 2 insert succeeded with id=${stage2.id.slice(0, 8)}…`);

  // ── 12. UPDATE ─────────────────────────────────────────────────────
  console.log('\n── UPDATE ──');
  db.update(workflowRuns)
    .set({ status: 'completed', completedAt: new Date().toISOString() })
    .where(eq(workflowRuns.id, run.id))
    .run();
  const updatedRun = db.select().from(workflowRuns).where(eq(workflowRuns.id, run.id)).get()!;
  assert(updatedRun.status === 'completed', `Updated status = '${updatedRun.status}'`);
  assert(!!updatedRun.completedAt, `completedAt set: ${updatedRun.completedAt}`);

  // ── 13. JSON column in stageExecutions ─────────────────────────────
  console.log('\n── JSON column in stageExecutions ──');
  const readStage = db.select().from(stageExecutions).where(eq(stageExecutions.id, stage.id)).get()!;
  const parsedUsage = JSON.parse(readStage.usageStats!);
  assert(parsedUsage.durationMs === 12345, `usageStats.durationMs = ${parsedUsage.durationMs}`);
  assert(parsedUsage.tokensIn === 500, `usageStats.tokensIn = ${parsedUsage.tokensIn}`);

  // ── 14. Boolean column ─────────────────────────────────────────────
  console.log('\n── Boolean column ──');
  assert(readTmpl.isBuiltIn === true, `isBuiltIn = ${readTmpl.isBuiltIn} (expected true)`);
  const tmpl2 = db.insert(workflowTemplates).values({
    name: 'custom-workflow',
    stages: '[]',
  }).returning().get();
  const readTmpl2 = db.select().from(workflowTemplates).where(eq(workflowTemplates.id, tmpl2.id)).get()!;
  assert(readTmpl2.isBuiltIn === false, `Default isBuiltIn = ${readTmpl2.isBuiltIn} (expected false)`);

  // ── 15. WAL file exists ────────────────────────────────────────────
  console.log('\n── WAL file check ──');
  assert(fs.existsSync(DB_PATH + '-wal'), `WAL file exists at ${DB_PATH}-wal`);

  // ── Summary ────────────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(50)}`);
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('═'.repeat(50));

} finally {
  closeDb();
  // Clean up test DB
  for (const f of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
}

process.exit(failed > 0 ? 1 : 0);
