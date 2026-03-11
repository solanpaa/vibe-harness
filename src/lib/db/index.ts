import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import Database from "better-sqlite3";
import path from "path";
import * as schema from "./schema";

const DB_PATH = process.env.DATABASE_URL || "./vibe-harness.db";

let db: ReturnType<typeof createDb>;
let migrated = false;

function createDb() {
  const sqlite = new Database(DB_PATH);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  return drizzle(sqlite, { schema });
}

export function getDb() {
  if (!db) {
    db = createDb();
  }
  if (!migrated) {
    try {
      const migrationsFolder = path.join(
        process.cwd(),
        "src/lib/db/migrations"
      );
      migrate(db, { migrationsFolder });
      migrated = true;
    } catch (e) {
      console.error("Migration error:", e);
    }
  }
  return db;
}

export type Db = ReturnType<typeof getDb>;
export { schema };
