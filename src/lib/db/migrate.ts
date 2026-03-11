import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { getDb } from "./index";
import path from "path";

export function runMigrations() {
  const db = getDb();
  const migrationsFolder = path.join(
    process.cwd(),
    "src/lib/db/migrations"
  );
  migrate(db, { migrationsFolder });
}

// Seed default agent definition
export function seedDefaults() {
  const db = getDb();
  const existing = db.query.agentDefinitions.findFirst();
  if (!existing) {
    const now = new Date().toISOString();
    db.insert(
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
