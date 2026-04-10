import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { createClient, type Client } from "@libsql/client";
import path from "path";
import { fileURLToPath } from "url";
import { eq } from "drizzle-orm";
import * as schema from "./schema";
import {
  getDefaultWorkflowStages,
  getDirectExecuteStages,
} from "@/lib/services/workflow-engine";

const DB_PATH = process.env.DATABASE_URL || "file:./vibe-harness.db";

type DbInstance = ReturnType<typeof drizzle<typeof schema>>;
let db: DbInstance;
let client: Client;
let initialized = false;

function createDb() {
  client = createClient({ url: DB_PATH });
  return drizzle(client, { schema });
}

async function initPragmas() {
  await client.execute("PRAGMA journal_mode = WAL");
  await client.execute("PRAGMA foreign_keys = ON");
  await client.execute("PRAGMA busy_timeout = 5000");
}

async function seedDefaults(database: DbInstance) {
  const existing = await database
    .select()
    .from(schema.agentDefinitions)
    .get();
  if (!existing) {
    const now = new Date().toISOString();
    await database
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
    const defaultAgent = await database
      .select()
      .from(schema.agentDefinitions)
      .where(eq(schema.agentDefinitions.id, "00000000-0000-0000-0000-000000000001"))
      .get();
    if (defaultAgent && !defaultAgent.dockerImage) {
      await database
        .update(schema.agentDefinitions)
        .set({ dockerImage: "vibe-harness/copilot:latest" })
        .where(eq(schema.agentDefinitions.id, "00000000-0000-0000-0000-000000000001"))
        .run();
    }
  }

  await seedWorkflowTemplates(database);
}

async function seedWorkflowTemplates(database: DbInstance) {
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

  const staleIds = ["00000000-0000-0000-0000-000000000011"];
  for (const staleId of staleIds) {
    await database
      .delete(schema.workflowTemplates)
      .where(eq(schema.workflowTemplates.id, staleId))
      .run();
  }
  const allTemplates = await database
    .select()
    .from(schema.workflowTemplates)
    .all();
  const subTaskTemplate = allTemplates
    .find((t) => t.name === "Implement & Review (Sub-task)");
  if (subTaskTemplate) {
    await database
      .delete(schema.workflowTemplates)
      .where(eq(schema.workflowTemplates.id, subTaskTemplate.id))
      .run();
  }

  for (const t of templates) {
    const existing = await database
      .select()
      .from(schema.workflowTemplates)
      .where(eq(schema.workflowTemplates.id, t.id))
      .get();
    if (!existing) {
      const now = new Date().toISOString();
      await database
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
      await database
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

export async function getDb() {
  if (!db) {
    db = createDb();
  }
  if (!initialized) {
    try {
      await initPragmas();
      const __dirname = path.dirname(fileURLToPath(import.meta.url));
      const migrationsFolder = path.join(
        __dirname,
        "migrations"
      );
      await migrate(db, { migrationsFolder });
      await seedDefaults(db);
      initialized = true;
    } catch (e) {
      console.error("Migration/seed error:", e);
      throw e;
    }
  }
  return db;
}

export type Db = DbInstance;
export { schema };
