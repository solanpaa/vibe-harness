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
import { inspectImage } from '../lib/image-inspector.js';
import type { LocalRegistry } from '../services/local-registry.js';
import { execFile, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const agents = new Hono();

// The build route needs access to the local registry to push freshly-built
// images. We accept it via a setter so the route can be wired up at app
// bootstrap without import-time side effects.
let localRegistry: LocalRegistry | null = null;
export function setAgentsRouteDeps(deps: { localRegistry: LocalRegistry }): void {
  localRegistry = deps.localRegistry;
}

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

  if (existing.isBuiltIn) {
    return c.json(
      { error: { code: 'CONFLICT', message: 'Cannot modify built-in agent' } },
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

// POST /api/agents/:id/build — build a container image from the stored
// Dockerfile so microsandbox can boot it. Pipeline:
//   1. docker buildx build -t <image> <buildDir>      (or `podman build` fallback)
//
// Microsandbox can boot images directly from the host docker/podman cache —
// no separate "template load" step is needed. If the host has neither
// docker nor podman, the build fails with a clear error.
agents.post('/api/agents/:id/build', (c) => {
  const id = c.req.param('id');
  const db = getDb();

  const agent = db.select().from(schema.agentDefinitions)
    .where(eq(schema.agentDefinitions.id, id)).get();
  if (!agent) return c.json({ error: { code: 'NOT_FOUND' } }, 404);
  if (!agent.dockerfile) return c.json({ error: { code: 'NO_DOCKERFILE', message: 'No Dockerfile defined' } }, 400);
  if (!agent.dockerImage) return c.json({ error: { code: 'NO_IMAGE_NAME', message: 'No image name defined' } }, 400);

  const log = logger.child({ agentId: id, imageName: agent.dockerImage });
  log.info('Starting container image build');

  const buildDir = mkdtempSync(join(tmpdir(), 'vibe-build-'));
  writeFileSync(join(buildDir, 'Dockerfile'), agent.dockerfile);

  const imageName = agent.dockerImage;

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const send = (data: string) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ output: data })}\n\n`));
      };
      const finish = (success: boolean) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ done: true, success })}\n\n`));
        controller.close();
        try { rmSync(buildDir, { recursive: true }); } catch { /* best-effort cleanup */ }
      };

      const runStep = (label: string, cmd: string, args: string[]): Promise<number> =>
        new Promise((resolve, reject) => {
          send(`\n▶ ${label}: ${cmd} ${args.join(' ')}\n`);
          let proc: ChildProcess;
          try {
            proc = execFile(cmd, args, { timeout: 600_000 });
          } catch (err) {
            reject(err);
            return;
          }
          proc.stdout?.on('data', (chunk: Buffer) => send(chunk.toString()));
          proc.stderr?.on('data', (chunk: Buffer) => send(chunk.toString()));
          proc.on('error', (err: Error) => reject(err));
          proc.on('close', (code: number | null) => resolve(code ?? 1));
        });

      // Pick the available container builder + a strategy for getting the
      // image into the daemon-managed local registry. Three paths, in order
      // of preference:
      //   1. `docker buildx build --push` — pushes directly to the registry,
      //      bypassing the docker daemon's image store. This is the only path
      //      that reliably works with plain HTTP registries: `docker push`
      //      after `buildx --load` hangs because buildx produces multi-arch
      //      / attested manifests the classic push client cannot ship.
      //   2. `docker build` + `localRegistry.pushImage()` (no buildx).
      //   3. `podman build` + `localRegistry.pushImage()`.
      //
      // The host architecture is pinned so buildx produces a single-platform
      // image (no manifest list), which microsandbox can boot.
      const hostArch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'amd64' : process.arch;
      const platform = `linux/${hostArch}`;

      interface BuilderStrategy {
        cmd: string;
        args: (registryRef: string) => string[];
        /** True when the build step already pushed the image (--push). */
        pushedDirectly: boolean;
        registryRef: string;
      }

      const detectBuilder = async (): Promise<BuilderStrategy | null> => {
        if (!localRegistry) return null;
        const registryRef = localRegistry.rewriteImageRef(imageName); // host-side ref (localhost:5050/...)
        const pushRef = localRegistry.pushRef(imageName);              // buildx-side ref (host.docker.internal:5050/...)
        const tryRun = (cmd: string, args: string[]): Promise<boolean> =>
          new Promise((resolve) => {
            execFile(cmd, args, { timeout: 5_000 }, (err) => resolve(!err));
          });
        if (await tryRun('docker', ['buildx', 'version'])) {
          return {
            cmd: 'docker',
            // BuildKit's `--output type=image,...,push=true,registry.insecure=true`
            // allows plain-HTTP pushes. We push under `host.docker.internal:5050`
            // because Docker Desktop's BuildKit runs in a separate VM and cannot
            // reach the host's `localhost`. The registry stores blobs by image
            // path only, so the daemon and microsandbox can then pull the same
            // blobs back at `localhost:5050/<image>`.
            args: (_ref) => [
              'buildx', 'build',
              '--provenance=false',
              '--platform', platform,
              '--output',
              `type=image,name=${pushRef},push=true,registry.insecure=true`,
              buildDir,
            ],
            pushedDirectly: true,
            registryRef,
          };
        }
        if (await tryRun('docker', ['version'])) {
          return {
            cmd: 'docker',
            args: (_ref) => ['build', '--platform', platform, '-t', imageName, buildDir],
            pushedDirectly: false,
            registryRef,
          };
        }
        if (await tryRun('podman', ['version'])) {
          return {
            cmd: 'podman',
            args: (_ref) => ['build', '--platform', platform, '-t', imageName, buildDir],
            pushedDirectly: false,
            registryRef,
          };
        }
        return null;
      };

      (async () => {
        try {
          if (!localRegistry) {
            send('\n❌ Local registry not wired into the daemon — cannot push image.\n');
            log.error('localRegistry dependency missing on agents route');
            finish(false);
            return;
          }
          // Make sure the registry is up BEFORE we kick off a long build,
          // so the user sees the "booting registry" message early.
          send(`\n▶ Ensuring local registry at ${localRegistry.endpoint()} is running\n`);
          try {
            await localRegistry.ensureRunning();
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            send(`\n❌ Failed to start local registry: ${message}\n`);
            log.error({ err }, 'Local registry start failed');
            finish(false);
            return;
          }

          const builder = await detectBuilder();
          if (!builder) {
            send(
              '\n❌ No container image builder found. Install Docker (with buildx) or Podman: ' +
              'https://docs.docker.com/get-docker/ or https://podman.io/docs/installation\n',
            );
            log.warn('No container builder available');
            finish(false);
            return;
          }

          const targetRef = builder.pushedDirectly ? builder.registryRef : imageName;
          const code = await runStep(
            builder.pushedDirectly
              ? `Building + pushing ${builder.registryRef} via ${builder.cmd} buildx`
              : `Building image ${imageName} with ${builder.cmd}`,
            builder.cmd,
            builder.args(targetRef),
          );
          if (code !== 0) {
            send(`\n❌ ${builder.cmd} build failed (exit code ${code})\n`);
            log.warn({ exitCode: code, builder: builder.cmd }, 'Image build failed');
            finish(false);
            return;
          }

          if (!builder.pushedDirectly) {
            try {
              const builderName = builder.cmd === 'podman' ? 'podman' : 'docker';
              await localRegistry.pushImage(imageName, builderName, { onLine: send });
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              send(`\n❌ Failed to push image to local registry: ${message}\n`);
              log.error({ err }, 'Local registry push failed');
              finish(false);
              return;
            }
          }

          send(`\n✅ Build succeeded — image available at ${builder.registryRef}\n`);
          log.info(
            { registryRef: builder.registryRef, builder: builder.cmd, pushedDirectly: builder.pushedDirectly },
            'Image built and pushed to local registry',
          );
          // We don't prewarm the microsandbox image cache here — the pull
          // happens at first-workflow-run time. (Prewarming via a throwaway
          // Sandbox.create() has been observed to stall in the SDK's pull
          // layer for reasons we haven't isolated; on-demand pull from the
          // workflow path works reliably and the 30-minute mutex timeout in
          // SandboxService.getOrCreate accommodates large agent images.)
          finish(true);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          send(`\n❌ Build error: ${message}\n`);
          log.error({ err }, 'Image build error');
          finish(false);
        }
      })();
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

// GET /api/agents/:id/image-status — check whether the agent's image is
// available to microsandbox. We probe the daemon's local registry first
// (that's where microsandbox actually pulls from for daemon-built images),
// then fall back to docker/podman/microsandbox-runtime caches for
// registry-qualified refs.
agents.get('/api/agents/:id/image-status', async (c) => {
  const id = c.req.param('id');
  const db = getDb();

  const agent = db.select().from(schema.agentDefinitions)
    .where(eq(schema.agentDefinitions.id, id)).get();
  if (!agent) return c.json({ error: { code: 'NOT_FOUND' } }, 404);
  if (!agent.dockerImage) return c.json({ exists: false, image: null });

  if (localRegistry && !localRegistry.isRegistryQualified(agent.dockerImage)) {
    try {
      if (await localRegistry.manifestExists(agent.dockerImage)) {
        return c.json({
          exists: true,
          image: agent.dockerImage,
          imageId: '',
          created: '',
          sizeMB: 0,
          source: 'local-registry',
          registryEndpoint: localRegistry.endpoint(),
        });
      }
    } catch {
      /* registry not running / not reachable — fall through */
    }
  }

  const info = await inspectImage(agent.dockerImage);
  if (!info.exists) return c.json({ exists: false, image: agent.dockerImage });

  return c.json({
    exists: true,
    image: info.image,
    imageId: info.imageId.slice(0, 19),
    created: info.created,
    sizeMB: Math.round(info.sizeBytes / 1024 / 1024),
    source: info.source,
  });
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
      { error: { code: 'CONFLICT', message: 'Cannot delete built-in agent' } },
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
