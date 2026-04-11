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
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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
  const agent = db
    .insert(schema.agentDefinitions)
    .values({
      ...parsed.data,
      dockerImage: parsed.data.dockerImage ?? null,
      description: parsed.data.description ?? null,
      isBuiltIn: false,
    })
    .returning()
    .get();

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
  if (data.dockerfile !== undefined) updates.dockerfile = data.dockerfile;
  if (data.description !== undefined) updates.description = data.description;
  if (data.supportsStreaming !== undefined) updates.supportsStreaming = data.supportsStreaming;
  if (data.supportsContinue !== undefined) updates.supportsContinue = data.supportsContinue;
  if (data.supportsIntervention !== undefined) updates.supportsIntervention = data.supportsIntervention;
  if (data.outputFormat !== undefined) updates.outputFormat = data.outputFormat;

  const updated = db
    .update(schema.agentDefinitions)
    .set(updates)
    .where(eq(schema.agentDefinitions.id, id))
    .returning()
    .get();

  return c.json(updated);
});

// POST /api/agents/:id/build — build Docker image from Dockerfile
agents.post('/api/agents/:id/build', (c) => {
  const id = c.req.param('id');
  const db = getDb();

  const agent = db.select().from(schema.agentDefinitions)
    .where(eq(schema.agentDefinitions.id, id)).get();
  if (!agent) return c.json({ error: { code: 'NOT_FOUND' } }, 404);
  if (!agent.dockerfile) return c.json({ error: { code: 'NO_DOCKERFILE', message: 'No Dockerfile defined' } }, 400);
  if (!agent.dockerImage) return c.json({ error: { code: 'NO_IMAGE_NAME', message: 'No image name defined' } }, 400);

  const log = logger.child({ agentId: id, imageName: agent.dockerImage });
  log.info('Starting Docker image build');

  const buildDir = mkdtempSync(join(tmpdir(), 'vibe-build-'));
  writeFileSync(join(buildDir, 'Dockerfile'), agent.dockerfile);

  const imageName = agent.dockerImage;

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const send = (data: string) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ output: data })}\n\n`));
      };

      send(`Building image ${imageName}...\n`);

      const proc = execFile('docker', ['build', '-t', imageName, buildDir], {
        timeout: 600000,
      });

      proc.stdout?.on('data', (chunk: Buffer) => {
        send(chunk.toString());
      });

      proc.stderr?.on('data', (chunk: Buffer) => {
        send(chunk.toString());
      });

      proc.on('close', (code: number | null) => {
        if (code === 0) {
          send('\n✅ Build succeeded!\n');
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ done: true, success: true })}\n\n`));
          log.info('Docker image build succeeded');
        } else {
          send(`\n❌ Build failed (exit code ${code})\n`);
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ done: true, success: false })}\n\n`));
          log.warn({ exitCode: code }, 'Docker image build failed');
        }
        controller.close();
        try { rmSync(buildDir, { recursive: true }); } catch {}
      });

      proc.on('error', (err: Error) => {
        send(`\n❌ Build error: ${err.message}\n`);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ done: true, success: false })}\n\n`));
        controller.close();
        log.error({ err }, 'Docker image build error');
        try { rmSync(buildDir, { recursive: true }); } catch {}
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
});

// GET /api/agents/:id/image-status — check if Docker image exists locally
agents.get('/api/agents/:id/image-status', (c) => {
  const id = c.req.param('id');
  const db = getDb();

  const agent = db.select().from(schema.agentDefinitions)
    .where(eq(schema.agentDefinitions.id, id)).get();
  if (!agent) return c.json({ error: { code: 'NOT_FOUND' } }, 404);
  if (!agent.dockerImage) return c.json({ exists: false, image: null });

  try {
    const result = execFileSync('docker', [
      'image', 'inspect', agent.dockerImage,
      '--format', '{{.Id}} {{.Created}} {{.Size}}',
    ], { encoding: 'utf-8', timeout: 5000 }).trim();

    const [imageId, created, size] = result.split(' ');
    return c.json({
      exists: true,
      image: agent.dockerImage,
      imageId: imageId?.slice(0, 19),
      created,
      sizeMB: Math.round(parseInt(size || '0') / 1024 / 1024),
    });
  } catch {
    return c.json({ exists: false, image: agent.dockerImage });
  }
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
