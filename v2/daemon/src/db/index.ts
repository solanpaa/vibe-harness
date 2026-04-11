import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'path';
import * as schema from './schema.js';
import { seed } from './seed.js';

let db: ReturnType<typeof drizzle<typeof schema>> | null = null;
let sqlite: Database.Database | null = null;
let resolvedDbPath: string | null = null;

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
