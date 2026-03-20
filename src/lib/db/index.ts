import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import Database from "better-sqlite3";
import path from "path";
import { eq } from "drizzle-orm";
import * as schema from "./schema";
import {
  getDefaultWorkflowStages,
  getDirectExecuteStages,
} from "@/lib/services/workflow-engine";

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

  // Seed default workflow templates
  seedWorkflowTemplates(database);
}

/** Seed the built-in workflow templates if they don't exist yet. */
function seedWorkflowTemplates(database: ReturnType<typeof createDb>) {
  const templates = [
    {
      id: "00000000-0000-0000-0000-000000000010",
      name: "Plan → Implement → Review",
      description:
        "Standard 4-stage workflow: plan the work, implement, AI review, then fix issues.",
      stages: getDefaultWorkflowStages(),
    },
    {
      id: "00000000-0000-0000-0000-000000000012",
      name: "Direct Execute",
      description:
        "Single-stage: the agent implements your prompt directly. Best for focused, well-defined tasks.",
      stages: getDirectExecuteStages(),
    },
  ];

  // Remove stale seeded templates that are no longer built-in
  const staleIds = ["00000000-0000-0000-0000-000000000011"];
  for (const staleId of staleIds) {
    database
      .delete(schema.workflowTemplates)
      .where(eq(schema.workflowTemplates.id, staleId))
      .run();
  }
  // Remove on-demand sub-task template — sub-tasks now use Direct Execute
  const subTaskTemplate = database
    .select()
    .from(schema.workflowTemplates)
    .all()
    .find((t) => t.name === "Implement & Review (Sub-task)");
  if (subTaskTemplate) {
    database
      .delete(schema.workflowTemplates)
      .where(eq(schema.workflowTemplates.id, subTaskTemplate.id))
      .run();
  }

  for (const t of templates) {
    const existing = database
      .select()
      .from(schema.workflowTemplates)
      .where(eq(schema.workflowTemplates.id, t.id))
      .get();
    if (!existing) {
      const now = new Date().toISOString();
      database
        .insert(schema.workflowTemplates)
        .values({
          id: t.id,
          name: t.name,
          description: t.description,
          stages: JSON.stringify(t.stages),
          createdAt: now,
          updatedAt: now,
        })
        .run();
    } else {
      // Update existing seeded templates with latest stage definitions
      database
        .update(schema.workflowTemplates)
        .set({
          stages: JSON.stringify(t.stages),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(schema.workflowTemplates.id, t.id))
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
