import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'path';
import * as schema from './schema.js';
import { seed } from './seed.js';

let db: ReturnType<typeof drizzle<typeof schema>> | null = null;
let sqlite: Database.Database | null = null;
let resolvedDbPath: string | null = null;

const NON_TERMINAL_STATUSES = [
  'pending', 'provisioning', 'running', 'awaiting_review',
  'awaiting_proposals', 'waiting_for_children',
  'children_completed_with_failures', 'awaiting_conflict_resolution',
  'finalizing', 'stage_failed',
];

/**
 * Migration preflight (rubber-duck blocker #2).
 *
 * The split_config redesign reshapes how runs are launched. We refuse to
 * migrate while any workflow_runs are mid-flight to avoid partial state in
 * the new schema. Operator must cancel/clean them first.
 *
 * We detect "needs migration" by absence of the workflow_runs.split_config_json
 * column (the marker for migration 0005_split_config). If the column is
 * already present, the preflight is a no-op.
 */
function migrationPreflight(sqliteDb: Database.Database) {
  // workflow_runs may not exist yet on a fresh DB; in that case there's
  // nothing to preflight against.
  let hasWorkflowRuns = false;
  try {
    const tables = sqliteDb.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='workflow_runs'"
    ).all() as Array<{ name: string }>;
    hasWorkflowRuns = tables.length > 0;
  } catch {
    return;
  }
  if (!hasWorkflowRuns) return;

  const cols = sqliteDb.prepare("PRAGMA table_info('workflow_runs')").all() as Array<{ name: string }>;
  const hasSplitConfig = cols.some((c) => c.name === 'split_config_json');
  if (hasSplitConfig) return;

  const placeholders = NON_TERMINAL_STATUSES.map(() => '?').join(',');
  const row = sqliteDb
    .prepare(`SELECT COUNT(*) AS n FROM workflow_runs WHERE status IN (${placeholders})`)
    .get(...NON_TERMINAL_STATUSES) as { n: number };

  if (row.n > 0) {
    throw new Error(
      `[vibe-harness migration preflight] Refusing to apply schema migration ` +
      `0005_split_config: ${row.n} non-terminal workflow_runs exist. ` +
      `The split-execution redesign requires a clean run table. ` +
      `Cancel or delete in-flight runs first (via the GUI cancel action, or ` +
      `direct SQL on ~/.vibe-harness/vibe-harness.db).`
    );
  }
}

export function getDb(dbPath?: string) {
  if (db) return db;

  // Use provided path, previously resolved path, or derive from HOME
  const effectivePath = dbPath ?? resolvedDbPath
    ?? join(process.env.HOME ?? process.env.USERPROFILE ?? '.', '.vibe-harness', 'vibe-harness.db');

  resolvedDbPath = effectivePath;

  sqlite = new Database(effectivePath);

  // WAL mode for concurrent read performance
  sqlite.pragma('journal_mode = WAL');
  // Enforce FK constraints (off by default in SQLite)
  sqlite.pragma('foreign_keys = ON');

  // Block migration if non-terminal runs would be left in undefined state.
  migrationPreflight(sqlite);

  db = drizzle(sqlite, { schema });

  // Apply pending migrations, then seed built-in data
  migrate(db, { migrationsFolder: './drizzle' });
  seed(db);

  return db;
}

export function closeDb() {
  if (sqlite) {
    sqlite.close();
    sqlite = null;
    db = null;
  }
}

export function getRawDb(): Database.Database | null {
  return sqlite;
}
