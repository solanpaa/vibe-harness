import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';

let db: ReturnType<typeof drizzle<typeof schema>> | null = null;
let sqlite: Database.Database | null = null;

export function getDb(dbPath = './vibe-harness.db') {
  if (db) return db;

  sqlite = new Database(dbPath);

  // WAL mode for concurrent read performance
  sqlite.pragma('journal_mode = WAL');
  // Enforce FK constraints (off by default in SQLite)
  sqlite.pragma('foreign_keys = ON');

  db = drizzle(sqlite, { schema });
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
