// daemon/src/routes/workflows.ts — CDD-api §4

import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import * as schema from '../db/schema.js';
import { createWorkflowTemplateSchema, updateWorkflowTemplateSchema } from '../lib/validation/workflows.js';
import { logger } from '../lib/logger.js';
import type { WorkflowTemplate } from '@vibe-harness/shared';

const workflows = new Hono();

/** Parse the JSON stages column into a typed array. */
function toTemplate(row: typeof schema.workflowTemplates.$inferSelect): WorkflowTemplate {
  return {
    ...row,
    stages: JSON.parse(row.stages),
  };
}

// GET /api/workflows — list all templates
workflows.get('/api/workflows', (c) => {
  const db = getDb();
  const rows = db.select().from(schema.workflowTemplates).all();
  const templates = rows.map((r) => ({
    ...toTemplate(r),
    stageCount: JSON.parse(r.stages).length as number,
  }));
  return c.json({ templates });
});

// POST /api/workflows — create template
workflows.post('/api/workflows', async (c) => {
  const body = await c.req.json();
  const parsed = createWorkflowTemplateSchema.safeParse(body);

  if (!parsed.success) {
    return c.json(
      { error: { code: 'VALIDATION_ERROR', message: 'Invalid input', details: parsed.error.flatten() } },
      400,
    );
  }

  const { name, description, stages } = parsed.data;

  const db = getDb();
  const [template] = db
    .insert(schema.workflowTemplates)
    .values({
      name,
      description: description ?? null,
      stages: JSON.stringify(stages),
    })
    .returning();

  logger.info({ templateId: template.id, name }, 'Workflow template created');
  return c.json(toTemplate(template), 201);
});

// GET /api/workflows/:id — get template with parsed stages
workflows.get('/api/workflows/:id', (c) => {
  const db = getDb();
  const row = db
    .select()
    .from(schema.workflowTemplates)
    .where(eq(schema.workflowTemplates.id, c.req.param('id')))
    .get();

  if (!row) {
    return c.json(
      { error: { code: 'TEMPLATE_NOT_FOUND', message: 'Workflow template not found' } },
      404,
    );
  }

  return c.json(toTemplate(row));
});

// PUT /api/workflows/:id — update template (block if built-in)
workflows.put('/api/workflows/:id', async (c) => {
  const id = c.req.param('id');
  const db = getDb();

  const existing = db
    .select()
    .from(schema.workflowTemplates)
    .where(eq(schema.workflowTemplates.id, id))
    .get();

  if (!existing) {
    return c.json(
      { error: { code: 'TEMPLATE_NOT_FOUND', message: 'Workflow template not found' } },
      404,
    );
  }

  if (existing.isBuiltIn) {
    return c.json(
      { error: { code: 'FORBIDDEN', message: 'Cannot modify built-in templates' } },
      403,
    );
  }

  const body = await c.req.json();
  const parsed = updateWorkflowTemplateSchema.safeParse(body);

  if (!parsed.success) {
    return c.json(
      { error: { code: 'VALIDATION_ERROR', message: 'Invalid input', details: parsed.error.flatten() } },
      400,
    );
  }

  const updates: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  if (parsed.data.name !== undefined) updates.name = parsed.data.name;
  if (parsed.data.description !== undefined) updates.description = parsed.data.description;
  if (parsed.data.stages !== undefined) updates.stages = JSON.stringify(parsed.data.stages);

  const [updated] = db
    .update(schema.workflowTemplates)
    .set(updates)
    .where(eq(schema.workflowTemplates.id, id))
    .returning();

  logger.info({ templateId: id }, 'Workflow template updated');
  return c.json(toTemplate(updated));
});

// DELETE /api/workflows/:id — delete template (block if built-in, check no active runs)
workflows.delete('/api/workflows/:id', (c) => {
  const id = c.req.param('id');
  const db = getDb();

  const existing = db
    .select()
    .from(schema.workflowTemplates)
    .where(eq(schema.workflowTemplates.id, id))
    .get();

  if (!existing) {
    return c.json(
      { error: { code: 'TEMPLATE_NOT_FOUND', message: 'Workflow template not found' } },
      404,
    );
  }

  if (existing.isBuiltIn) {
    return c.json(
      { error: { code: 'FORBIDDEN', message: 'Cannot delete built-in templates' } },
      403,
    );
  }

  // Check for active (non-terminal) workflow runs using this template
  const activeRuns = db
    .select()
    .from(schema.workflowRuns)
    .where(eq(schema.workflowRuns.workflowTemplateId, id))
    .all()
    .filter((r) => !['completed', 'failed', 'cancelled'].includes(r.status));

  if (activeRuns.length > 0) {
    return c.json(
      { error: { code: 'CONFLICT', message: 'Cannot delete template with active workflow runs' } },
      409,
    );
  }

  db.delete(schema.workflowTemplates).where(eq(schema.workflowTemplates.id, id)).run();
  return c.body(null, 204);
});

export { workflows };
