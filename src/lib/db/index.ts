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
          name: "GitHub Copilot CLI",
          type: "copilot_cli",
          commandTemplate: "copilot",
          dockerImage: "vibe-harness/copilot:latest",
          description: "GitHub Copilot CLI via ACP protocol. Supports mid-session intervention.",
          createdAt: now,
        },
      ])
      .run();
  } else {
    // Backfill dockerImage for existing default agent if not set
    const defaultAgent = database
      .select()
      .from(schema.agentDefinitions)
      .where(eq(schema.agentDefinitions.id, "00000000-0000-0000-0000-000000000001"))
      .get();
    if (defaultAgent && !defaultAgent.dockerImage) {
      database
        .update(schema.agentDefinitions)
        .set({ dockerImage: "vibe-harness/copilot:latest" })
        .where(eq(schema.agentDefinitions.id, "00000000-0000-0000-0000-000000000001"))
        .run();
    }
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
