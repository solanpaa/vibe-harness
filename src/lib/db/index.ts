import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import Database from "better-sqlite3";
import path from "path";
import { eq } from "drizzle-orm";
import * as schema from "./schema";

const DB_PATH = process.env.DATABASE_URL || "./vibe-harness.db";

let db: ReturnType<typeof createDb>;
let initialized = false;

function createDb() {
  const sqlite = new Database(DB_PATH);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  return drizzle(sqlite, { schema });
}

function seedDefaults(database: ReturnType<typeof createDb>) {
  const existing = database
    .select()
    .from(schema.agentDefinitions)
    .get();
  if (!existing) {
    const now = new Date().toISOString();
    database
      .insert(schema.agentDefinitions)
      .values([
        {
          id: "00000000-0000-0000-0000-000000000001",
          name: "Claude (Docker Sandbox)",
          type: "claude_code",
          commandTemplate: "claude",
          description: "Claude Code running in a Docker sandbox",
          createdAt: now,
        },
        {
          id: "00000000-0000-0000-0000-000000000002",
          name: "Gemini (Docker Sandbox)",
          type: "custom",
          commandTemplate: "gemini",
          description: "Gemini CLI running in a Docker sandbox",
          createdAt: now,
        },
      ])
      .run();
  }
}

export function getDb() {
  if (!db) {
    db = createDb();
  }
  if (!initialized) {
    try {
      const migrationsFolder = path.join(
        process.cwd(),
        "src/lib/db/migrations"
      );
      migrate(db, { migrationsFolder });
      seedDefaults(db);
      initialized = true;
    } catch (e) {
      console.error("Migration/seed error:", e);
    }
  }
  return db;
}

export type Db = ReturnType<typeof getDb>;
export { schema };
