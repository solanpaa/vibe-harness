/**
 * Full schema validation: all 16 tables, FKs, indexes, unique constraints,
 * JSON round-trips, seed data, and WAL mode.
 */

import { eq } from 'drizzle-orm';
import { getDb, closeDb, getRawDb } from './index.js';
import * as S from './schema.js';
import fs from 'node:fs';

const DB_PATH = './test-vibe-harness.db';

// Clean up any previous test DB
for (const f of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) {
  if (fs.existsSync(f)) fs.unlinkSync(f);
}

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

function expectThrow(fn: () => void, pattern: RegExp, label: string) {
  try {
    fn();
    console.error(`  ❌ ${label} — expected error but none thrown`);
    failed++;
  } catch (e: any) {
    const ok = pattern.test(e.message);
    if (ok) {
      console.log(`  ✅ ${label}`);
      passed++;
    } else {
      console.error(`  ❌ ${label} — error: ${e.message.slice(0, 80)}`);
      failed++;
    }
  }
}

try {
  const db = getDb(DB_PATH);
  const raw = getRawDb()!;

  // ── 1. Basics ──────────────────────────────────────────────────────
  console.log('\n── WAL & FK pragmas ──');
  assert(raw.pragma('journal_mode', { simple: true }) === 'wal', 'WAL mode');
  assert(raw.pragma('foreign_keys', { simple: true }) === 1, 'FK enabled');

  // ── 2. All 16 tables exist ─────────────────────────────────────────
  console.log('\n── Tables created ──');
  const tables = raw
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%' ORDER BY name")
    .all()
    .map((r: any) => r.name);
  const expected = [
    'agent_definitions', 'credential_audit_log', 'credential_entries',
    'credential_sets', 'git_operations', 'hook_resumes', 'last_run_config',
    'parallel_groups', 'projects', 'proposals', 'review_comments',
    'reviews', 'run_messages', 'stage_executions', 'workflow_runs',
    'workflow_templates',
  ];
  for (const t of expected) {
    assert(tables.includes(t), `Table '${t}' exists`);
  }

  // ── 3. Seed data ───────────────────────────────────────────────────
  console.log('\n── Seed data ──');
  const agents = db.select().from(S.agentDefinitions).all();
  assert(agents.length >= 1, `Agent definitions seeded: ${agents.length}`);
  assert(agents.some(a => a.name === 'Copilot CLI' && a.isBuiltIn), 'Copilot CLI agent is built-in');

  const templates = db.select().from(S.workflowTemplates).all();
  assert(templates.length >= 3, `Workflow templates seeded: ${templates.length}`);
  for (const name of ['Quick Run', 'Plan & Implement', 'Full Review']) {
    assert(templates.some(t => t.name === name && t.isBuiltIn), `Template '${name}' exists and is built-in`);
  }

  // ── 4. Seed idempotency ────────────────────────────────────────────
  console.log('\n── Seed idempotency ──');
  const { seed } = await import('./seed.js');
  seed(db);
  const agents2 = db.select().from(S.agentDefinitions).all();
  assert(agents2.length === agents.length, 'Seed is idempotent (agents)');
  const templates2 = db.select().from(S.workflowTemplates).all();
  assert(templates2.length === templates.length, 'Seed is idempotent (templates)');

  // ── 5. Full CRUD — all major tables ────────────────────────────────
  console.log('\n── CRUD: projects ──');
  const proj = db.insert(S.projects).values({
    name: 'test-proj', localPath: '/home/test',
  }).returning().get();
  assert(!!proj.id && !!proj.createdAt, 'Project created');

  console.log('\n── CRUD: credentialSets ──');
  const credSet = db.insert(S.credentialSets).values({
    name: 'test-creds', projectId: proj.id,
  }).returning().get();
  assert(!!credSet.id, 'CredentialSet created');

  console.log('\n── CRUD: credentialEntries ──');
  const credEntry = db.insert(S.credentialEntries).values({
    credentialSetId: credSet.id, key: 'API_KEY', value: 'enc_secret',
    type: 'env_var',
  }).returning().get();
  assert(!!credEntry.id && !!credEntry.updatedAt, 'CredentialEntry created with updatedAt');

  console.log('\n── CRUD: credentialAuditLog ──');
  const audit = db.insert(S.credentialAuditLog).values({
    action: 'created', credentialSetId: credSet.id,
  }).returning().get();
  assert(!!audit.id, 'CredentialAuditLog entry created');

  const agent = agents[0];
  const tmpl = templates.find(t => t.name === 'Plan & Implement')!;

  console.log('\n── CRUD: workflowRuns ──');
  const run = db.insert(S.workflowRuns).values({
    workflowTemplateId: tmpl.id, projectId: proj.id,
    agentDefinitionId: agent.id, description: 'test run',
    model: 'gpt-4o',
  }).returning().get();
  assert(!!run.id && run.model === 'gpt-4o', 'WorkflowRun created with model');

  console.log('\n── CRUD: stageExecutions ──');
  const se = db.insert(S.stageExecutions).values({
    workflowRunId: run.id, stageName: 'plan', round: 1,
    model: 'gpt-4o', usageStats: JSON.stringify({ durationMs: 1000 }),
  }).returning().get();
  assert(!!se.id && se.model === 'gpt-4o', 'StageExecution created with model');

  console.log('\n── CRUD: runMessages ──');
  const msg = db.insert(S.runMessages).values({
    workflowRunId: run.id, stageName: 'plan', round: 1,
    role: 'user', content: 'Hello agent',
  }).returning().get();
  assert(!!msg.id, 'RunMessage created');

  console.log('\n── CRUD: reviews ──');
  const rev = db.insert(S.reviews).values({
    workflowRunId: run.id, stageName: 'plan', round: 1,
    type: 'stage', status: 'pending_review',
  }).returning().get();
  assert(!!rev.id, 'Review created (stage type)');

  const revCons = db.insert(S.reviews).values({
    workflowRunId: run.id, stageName: '__consolidation__', round: 1,
    type: 'consolidation', status: 'pending_review',
  }).returning().get();
  assert(!!revCons.id, 'Review created (consolidation sentinel)');

  console.log('\n── CRUD: reviewComments ──');
  const rc = db.insert(S.reviewComments).values({
    reviewId: rev.id, filePath: 'src/main.ts', lineNumber: 42,
    side: 'right', body: 'Looks good!',
  }).returning().get();
  assert(!!rc.id, 'ReviewComment created');

  console.log('\n── CRUD: parallelGroups ──');
  const pg = db.insert(S.parallelGroups).values({
    sourceWorkflowRunId: run.id, name: 'test-group',
  }).returning().get();
  assert(!!pg.id, 'ParallelGroup created');

  console.log('\n── CRUD: proposals ──');
  const prop = db.insert(S.proposals).values({
    workflowRunId: run.id, stageName: 'plan', title: 'Add auth',
    description: 'Add authentication module', parallelGroupId: pg.id,
    affectedFiles: JSON.stringify(['src/auth.ts']),
  }).returning().get();
  assert(!!prop.id && !!prop.updatedAt, 'Proposal created with parallelGroupId');

  console.log('\n── CRUD: lastRunConfig ──');
  db.insert(S.lastRunConfig).values({
    id: 1, projectId: proj.id, agentDefinitionId: agent.id,
    workflowTemplateId: tmpl.id,
  }).run();
  const lrc = db.select().from(S.lastRunConfig).get()!;
  assert(lrc.id === 1 && lrc.projectId === proj.id, 'lastRunConfig singleton');

  console.log('\n── CRUD: hookResumes ──');
  const hr = db.insert(S.hookResumes).values({
    hookToken: 'tok-123', action: JSON.stringify({ type: 'approve' }),
  }).returning().get();
  assert(!!hr.id, 'HookResume created');

  console.log('\n── CRUD: gitOperations ──');
  const gitOp = db.insert(S.gitOperations).values({
    type: 'finalize', workflowRunId: run.id, phase: 'commit',
    metadata: JSON.stringify({ branch: 'main' }),
  }).returning().get();
  assert(!!gitOp.id, 'GitOperation created');

  // ── 6. FK constraint enforcement ───────────────────────────────────
  console.log('\n── FK constraints ──');
  expectThrow(
    () => db.insert(S.workflowRuns).values({
      workflowTemplateId: 'bad-id', projectId: proj.id,
      agentDefinitionId: agent.id,
    }).run(),
    /FOREIGN KEY/,
    'FK violation on workflowRuns.workflowTemplateId',
  );
  expectThrow(
    () => db.insert(S.stageExecutions).values({
      workflowRunId: 'bad-id', stageName: 'x', round: 1,
    }).run(),
    /FOREIGN KEY/,
    'FK violation on stageExecutions.workflowRunId',
  );

  // ── 7. UNIQUE constraints ──────────────────────────────────────────
  console.log('\n── UNIQUE constraints ──');
  expectThrow(
    () => db.insert(S.stageExecutions).values({
      workflowRunId: run.id, stageName: 'plan', round: 1,
    }).run(),
    /UNIQUE/,
    'UNIQUE on stageExecutions (run, stage, round)',
  );
  expectThrow(
    () => db.insert(S.reviews).values({
      workflowRunId: run.id, stageName: 'plan', round: 1, type: 'stage',
    }).run(),
    /UNIQUE/,
    'UNIQUE on reviews (run, stage, round, type)',
  );
  expectThrow(
    () => db.insert(S.proposals).values({
      workflowRunId: run.id, stageName: 'plan', title: 'Add auth',
      description: 'dup',
    }).run(),
    /UNIQUE/,
    'UNIQUE on proposals (run, stage, title)',
  );
  expectThrow(
    () => db.insert(S.gitOperations).values({
      type: 'finalize', workflowRunId: run.id, phase: 'merge',
    }).run(),
    /UNIQUE/,
    'UNIQUE on gitOperations (run, type)',
  );
  expectThrow(
    () => db.insert(S.hookResumes).values({
      hookToken: 'tok-123', action: '{}',
    }).run(),
    /UNIQUE/,
    'UNIQUE on hookResumes.hookToken',
  );

  // ── 8. UNIQUE allows different key values ──────────────────────────
  console.log('\n── UNIQUE allows different values ──');
  const se2 = db.insert(S.stageExecutions).values({
    workflowRunId: run.id, stageName: 'plan', round: 2,
  }).returning().get();
  assert(!!se2.id, 'Different round succeeds for stageExecutions');

  // ── 9. JSON round-trips ────────────────────────────────────────────
  console.log('\n── JSON round-trips ──');
  const readTmpl = db.select().from(S.workflowTemplates).where(eq(S.workflowTemplates.id, tmpl.id)).get()!;
  const stages = JSON.parse(readTmpl.stages);
  assert(Array.isArray(stages) && stages.length === 3, 'Template stages JSON round-trip');
  const readUsage = JSON.parse(
    db.select().from(S.stageExecutions).where(eq(S.stageExecutions.id, se.id)).get()!.usageStats!,
  );
  assert(readUsage.durationMs === 1000, 'UsageStats JSON round-trip');

  // ── 10. Cascade deletes ────────────────────────────────────────────
  console.log('\n── Cascade deletes ──');
  // reviewComments should cascade when review is deleted
  const rcBefore = db.select().from(S.reviewComments).where(eq(S.reviewComments.reviewId, rev.id)).all();
  assert(rcBefore.length === 1, 'ReviewComment exists before review delete');
  raw.prepare('DELETE FROM reviews WHERE id = ?').run(rev.id);
  const rcAfter = db.select().from(S.reviewComments).where(eq(S.reviewComments.reviewId, rev.id)).all();
  assert(rcAfter.length === 0, 'ReviewComments cascade-deleted with review');

  // ── 11. onDelete: set null — proposals.parallelGroupId ─────────────
  console.log('\n── onDelete set null ──');
  const propBefore = db.select().from(S.proposals).where(eq(S.proposals.id, prop.id)).get()!;
  assert(propBefore.parallelGroupId === pg.id, 'Proposal has parallelGroupId before delete');
  raw.prepare('DELETE FROM parallel_groups WHERE id = ?').run(pg.id);
  const propAfter = db.select().from(S.proposals).where(eq(S.proposals.id, prop.id)).get()!;
  assert(propAfter.parallelGroupId === null, 'proposals.parallelGroupId set null after group delete');

  // ── 12. WAL file check ─────────────────────────────────────────────
  console.log('\n── WAL file ──');
  assert(fs.existsSync(DB_PATH + '-wal'), 'WAL file exists');

  // ── Summary ────────────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(50)}`);
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('═'.repeat(50));

} finally {
  closeDb();
  for (const f of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
}

process.exit(failed > 0 ? 1 : 0);
