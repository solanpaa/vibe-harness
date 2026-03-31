import { migrate } from "drizzle-orm/libsql/migrator";
import { getDb } from "./index";
import path from "path";
import { fileURLToPath } from "url";

export async function runMigrations() {
  const db = await getDb();
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const migrationsFolder = path.join(
    __dirname,
    "migrations"
  );
  await migrate(db, { migrationsFolder });
}

export async function seedDefaults() {
  const db = await getDb();
  const existing = await db.query.agentDefinitions.findFirst();
  if (!existing) {
    const now = new Date().toISOString();
    await db.insert(
      require("./schema").agentDefinitions
    ).values({
      id: "00000000-0000-0000-0000-000000000001",
      name: "GitHub Copilot CLI",
      type: "copilot_cli",
      commandTemplate: "docker sandbox run copilot {{projectDir}}",
      description: "GitHub Copilot CLI running in a Docker sandbox",
      createdAt: now,
    }).run();
  }
}
