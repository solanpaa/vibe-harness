// daemon/src/routes/settings.ts

import { Hono } from 'hono';
import { getDb } from '../db/index.js';
import * as schema from '../db/schema.js';
import { eq } from 'drizzle-orm';

const settingsRoute = new Hono();

// GET /api/settings — list all settings as key-value object
settingsRoute.get('/api/settings', (c) => {
  const db = getDb();
  const rows = db.select().from(schema.settings).all();
  const settings: Record<string, string> = {};
  for (const row of rows) {
    settings[row.key] = row.value;
  }
  return c.json({ settings });
});

// PATCH /api/settings — upsert key-value pairs
settingsRoute.patch('/api/settings', async (c) => {
  const body = await c.req.json<{ settings: Record<string, string> }>();
  const db = getDb();
  const now = new Date().toISOString();

  for (const [key, value] of Object.entries(body.settings)) {
    db.insert(schema.settings)
      .values({ key, value, updatedAt: now })
      .onConflictDoUpdate({
        target: schema.settings.key,
        set: { value, updatedAt: now },
      })
      .run();
  }

  // Return full settings object
  const rows = db.select().from(schema.settings).all();
  const settings: Record<string, string> = {};
  for (const row of rows) {
    settings[row.key] = row.value;
  }
  return c.json({ settings });
});

export { settingsRoute };
