// daemon/src/routes/settings.ts

import { Hono } from 'hono';
import { getDb } from '../db/index.js';
import * as schema from '../db/schema.js';
import { eq } from 'drizzle-orm';
import {
  defaultSplitterPromptTemplateSchema,
  defaultPostSplitStagesSchema,
} from '../lib/validation/workflows.js';

const settingsRoute = new Hono();

// Typed validators for known settings keys (rubber-duck blockers #1, #10).
// Unknown keys pass through unchanged for forward compatibility, but known
// keys MUST be valid or the entire PATCH is rejected.
function validateKnownSetting(key: string, value: string): string | null {
  switch (key) {
    case 'defaultSplitterPromptTemplate': {
      const parsed = defaultSplitterPromptTemplateSchema.safeParse(value);
      if (!parsed.success) {
        return `Invalid ${key}: ${parsed.error.issues.map((i) => i.message).join('; ')}`;
      }
      return null;
    }
    case 'defaultPostSplitStages': {
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(value);
      } catch {
        return `Invalid ${key}: not valid JSON`;
      }
      const parsed = defaultPostSplitStagesSchema.safeParse(parsedJson);
      if (!parsed.success) {
        return `Invalid ${key}: ${parsed.error.issues.map((i) => i.message).join('; ')}`;
      }
      return null;
    }
    default:
      return null;
  }
}

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

// PATCH /api/settings — upsert key-value pairs (typed where applicable)
settingsRoute.patch('/api/settings', async (c) => {
  const body = await c.req.json<{ settings: Record<string, string> }>();
  if (!body?.settings || typeof body.settings !== 'object') {
    return c.json(
      { error: { code: 'VALIDATION_ERROR', message: 'Body must be { settings: { key: value, ... } }' } },
      400,
    );
  }

  // Pre-flight: validate all known keys before writing anything.
  const errors: Array<{ key: string; message: string }> = [];
  for (const [key, value] of Object.entries(body.settings)) {
    if (typeof value !== 'string') {
      errors.push({ key, message: `Value must be a string` });
      continue;
    }
    const err = validateKnownSetting(key, value);
    if (err) errors.push({ key, message: err });
  }
  if (errors.length > 0) {
    return c.json(
      { error: { code: 'VALIDATION_ERROR', message: 'Invalid settings', details: errors } },
      400,
    );
  }

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

