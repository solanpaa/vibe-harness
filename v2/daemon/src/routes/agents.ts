// daemon/src/routes/agents.ts — CDD-api §9

import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import * as schema from '../db/schema.js';
import {
  createAgentDefinitionSchema,
  updateAgentDefinitionSchema,
} from '../lib/validation/agents.js';
import { logger } from '../lib/logger.js';

const agents = new Hono();

// GET /api/agents — list all agent definitions
agents.get('/api/agents', (c) => {
  const db = getDb();
  const rows = db.select().from(schema.agentDefinitions).all();
  return c.json({ agents: rows });
});

// GET /api/agents/:id — get single agent
agents.get('/api/agents/:id', (c) => {
  const db = getDb();
  const agent = db
    .select()
    .from(schema.agentDefinitions)
    .where(eq(schema.agentDefinitions.id, c.req.param('id')))
    .get();

  if (!agent) {
    return c.json(
      { error: { code: 'AGENT_NOT_FOUND', message: 'Agent definition not found' } },
      404,
    );
  }

  return c.json(agent);
});

// POST /api/agents — create agent definition
agents.post('/api/agents', async (c) => {
  const body = await c.req.json();
  const parsed = createAgentDefinitionSchema.safeParse(body);

  if (!parsed.success) {
    return c.json(
      { error: { code: 'VALIDATION_ERROR', message: 'Invalid input', details: parsed.error.flatten() } },
      400,
    );
  }

  const db = getDb();
  const [agent] = db
    .insert(schema.agentDefinitions)
    .values({
      ...parsed.data,
      dockerImage: parsed.data.dockerImage ?? null,
      description: parsed.data.description ?? null,
      isBuiltIn: false,
    })
    .returning();

  logger.info({ agentId: agent.id, name: agent.name }, 'Agent definition created');
  return c.json(agent, 201);
});

// PUT /api/agents/:id — update agent definition
agents.put('/api/agents/:id', async (c) => {
  const id = c.req.param('id');
  const db = getDb();

  const existing = db
    .select()
    .from(schema.agentDefinitions)
    .where(eq(schema.agentDefinitions.id, id))
    .get();

  if (!existing) {
    return c.json(
      { error: { code: 'AGENT_NOT_FOUND', message: 'Agent definition not found' } },
      404,
    );
  }

  if (existing.isBuiltIn) {
    return c.json(
      { error: { code: 'CONFLICT', message: 'Cannot modify built-in agent definition' } },
      409,
    );
  }

  const body = await c.req.json();
  const parsed = updateAgentDefinitionSchema.safeParse(body);

  if (!parsed.success) {
    return c.json(
      { error: { code: 'VALIDATION_ERROR', message: 'Invalid input', details: parsed.error.flatten() } },
      400,
    );
  }

  const updates: Record<string, unknown> = {};
  const data = parsed.data;
  if (data.name !== undefined) updates.name = data.name;
  if (data.commandTemplate !== undefined) updates.commandTemplate = data.commandTemplate;
  if (data.dockerImage !== undefined) updates.dockerImage = data.dockerImage;
  if (data.description !== undefined) updates.description = data.description;
  if (data.supportsStreaming !== undefined) updates.supportsStreaming = data.supportsStreaming;
  if (data.supportsContinue !== undefined) updates.supportsContinue = data.supportsContinue;
  if (data.supportsIntervention !== undefined) updates.supportsIntervention = data.supportsIntervention;
  if (data.outputFormat !== undefined) updates.outputFormat = data.outputFormat;

  const [updated] = db
    .update(schema.agentDefinitions)
    .set(updates)
    .where(eq(schema.agentDefinitions.id, id))
    .returning();

  return c.json(updated);
});

// DELETE /api/agents/:id — delete agent definition
agents.delete('/api/agents/:id', (c) => {
  const id = c.req.param('id');
  const db = getDb();

  const existing = db
    .select()
    .from(schema.agentDefinitions)
    .where(eq(schema.agentDefinitions.id, id))
    .get();

  if (!existing) {
    return c.json(
      { error: { code: 'AGENT_NOT_FOUND', message: 'Agent definition not found' } },
      404,
    );
  }

  if (existing.isBuiltIn) {
    return c.json(
      { error: { code: 'CONFLICT', message: 'Cannot delete built-in agent definition' } },
      409,
    );
  }

  // Check for active runs referencing this agent
  const activeRuns = db
    .select()
    .from(schema.workflowRuns)
    .where(eq(schema.workflowRuns.agentDefinitionId, id))
    .all()
    .filter((r) => !['completed', 'failed', 'cancelled'].includes(r.status));

  if (activeRuns.length > 0) {
    return c.json(
      { error: { code: 'AGENT_IN_USE', message: 'Cannot delete agent with active workflow runs' } },
      409,
    );
  }

  db.delete(schema.agentDefinitions).where(eq(schema.agentDefinitions.id, id)).run();
  return c.body(null, 204);
});

export { agents };
