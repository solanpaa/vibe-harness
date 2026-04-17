// daemon/src/routes/projects.ts — CDD-api §8

import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import * as schema from '../db/schema.js';
import { createProjectSchema, updateProjectSchema } from '../lib/validation/projects.js';
import { execCommand } from '../lib/shell.js';
import { logger } from '../lib/logger.js';
import { existsSync } from 'node:fs';

const projects = new Hono();

// GET /api/projects — list all projects
projects.get('/api/projects', (c) => {
  const db = getDb();
  const rows = db.select().from(schema.projects).all();
  return c.json({ projects: rows });
});

// POST /api/projects — create project
projects.post('/api/projects', async (c) => {
  const body = await c.req.json();
  const parsed = createProjectSchema.safeParse(body);

  if (!parsed.success) {
    return c.json(
      { error: { code: 'VALIDATION_ERROR', message: 'Invalid input', details: parsed.error.flatten() } },
      400,
    );
  }

  const { name, localPath, description, defaultCredentialSetId, ghAccount, sandboxMemory, sandboxCpus } = parsed.data;

  // Check path exists
  if (!existsSync(localPath)) {
    return c.json(
      { error: { code: 'PATH_NOT_FOUND', message: `Path does not exist: ${localPath}` } },
      404,
    );
  }

  // Validate git repo
  const gitCheck = await execCommand('git', ['-C', localPath, 'rev-parse', '--git-dir']);
  if (gitCheck.exitCode !== 0) {
    return c.json(
      { error: { code: 'INVALID_GIT_REPO', message: `Not a valid git repository: ${localPath}` } },
      400,
    );
  }

  const db = getDb();

  // FK check: verify credential set exists
  if (defaultCredentialSetId) {
    const credSet = db
      .select()
      .from(schema.credentialSets)
      .where(eq(schema.credentialSets.id, defaultCredentialSetId))
      .get();
    if (!credSet) {
      return c.json(
        { error: { code: 'CREDENTIAL_SET_NOT_FOUND', message: 'Credential set not found' } },
        404,
      );
    }
  }

  // Auto-extract gitUrl from remote origin
  let gitUrl: string | null = null;
  const remoteResult = await execCommand('git', ['-C', localPath, 'remote', 'get-url', 'origin']);
  if (remoteResult.exitCode === 0 && remoteResult.stdout.trim()) {
    gitUrl = remoteResult.stdout.trim();
  }

  const project = db
    .insert(schema.projects)
    .values({
      name,
      localPath,
      gitUrl,
      description: description ?? null,
      defaultCredentialSetId: defaultCredentialSetId ?? null,
      ghAccount: ghAccount ?? null,
      sandboxMemory: sandboxMemory ?? null,
      sandboxCpus: sandboxCpus ?? null,
    })
    .returning()
    .get();

  logger.info({ projectId: project.id, name }, 'Project created');
  return c.json(project, 201);
});

// GET /api/projects/:id — get project detail
projects.get('/api/projects/:id', (c) => {
  const db = getDb();
  const project = db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, c.req.param('id')))
    .get();

  if (!project) {
    return c.json(
      { error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found' } },
      404,
    );
  }

  return c.json(project);
});

// PATCH /api/projects/:id — update project
projects.patch('/api/projects/:id', async (c) => {
  const id = c.req.param('id');
  const db = getDb();

  const existing = db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, id))
    .get();

  if (!existing) {
    return c.json(
      { error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found' } },
      404,
    );
  }

  const body = await c.req.json();
  const parsed = updateProjectSchema.safeParse(body);

  if (!parsed.success) {
    return c.json(
      { error: { code: 'VALIDATION_ERROR', message: 'Invalid input', details: parsed.error.flatten() } },
      400,
    );
  }

  // FK check: verify credential set exists
  if (parsed.data.defaultCredentialSetId) {
    const credSet = db
      .select()
      .from(schema.credentialSets)
      .where(eq(schema.credentialSets.id, parsed.data.defaultCredentialSetId))
      .get();
    if (!credSet) {
      return c.json(
        { error: { code: 'CREDENTIAL_SET_NOT_FOUND', message: 'Credential set not found' } },
        404,
      );
    }
  }

  const updates: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  if (parsed.data.name !== undefined) updates.name = parsed.data.name;
  if (parsed.data.description !== undefined) updates.description = parsed.data.description;
  if (parsed.data.defaultCredentialSetId !== undefined)
    updates.defaultCredentialSetId = parsed.data.defaultCredentialSetId;
  if (parsed.data.ghAccount !== undefined) updates.ghAccount = parsed.data.ghAccount;
  if (parsed.data.sandboxMemory !== undefined) updates.sandboxMemory = parsed.data.sandboxMemory;
  if (parsed.data.sandboxCpus !== undefined) updates.sandboxCpus = parsed.data.sandboxCpus;

  const updated = db
    .update(schema.projects)
    .set(updates)
    .where(eq(schema.projects.id, id))
    .returning()
    .get();

  return c.json(updated);
});

// DELETE /api/projects/:id — delete project
projects.delete('/api/projects/:id', (c) => {
  const id = c.req.param('id');
  const db = getDb();

  const existing = db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, id))
    .get();

  if (!existing) {
    return c.json(
      { error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found' } },
      404,
    );
  }

  // Check for active (non-terminal) workflow runs
  const activeRuns = db
    .select()
    .from(schema.workflowRuns)
    .where(eq(schema.workflowRuns.projectId, id))
    .all()
    .filter((r) => !['completed', 'failed', 'cancelled'].includes(r.status));

  if (activeRuns.length > 0) {
    return c.json(
      { error: { code: 'CONFLICT', message: 'Cannot delete project with active workflow runs' } },
      409,
    );
  }

  db.delete(schema.projects).where(eq(schema.projects.id, id)).run();
  return c.body(null, 204);
});

// GET /api/projects/:id/branches — list branches
projects.get('/api/projects/:id/branches', async (c) => {
  const db = getDb();
  const project = db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, c.req.param('id')))
    .get();

  if (!project) {
    return c.json(
      { error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found' } },
      404,
    );
  }

  // Get current branch
  const headResult = await execCommand('git', ['-C', project.localPath, 'rev-parse', '--abbrev-ref', 'HEAD']);
  const currentBranch = headResult.exitCode === 0 && headResult.stdout.trim() !== 'HEAD'
    ? headResult.stdout.trim()
    : null;

  // List local branches with last commit SHA
  const branchResult = await execCommand('git', [
    '-C', project.localPath,
    'for-each-ref',
    '--format=%(refname:short)\t%(objectname:short)\t%(if)%(HEAD)%(then)*%(end)',
    'refs/heads/',
  ]);

  const branches: Array<{ name: string; isCurrent: boolean; isRemote: boolean; lastCommit: string | null }> = [];

  if (branchResult.exitCode === 0 && branchResult.stdout.trim()) {
    for (const line of branchResult.stdout.trim().split('\n')) {
      const [name, sha, marker] = line.split('\t');
      if (name) {
        branches.push({
          name,
          isCurrent: marker === '*',
          isRemote: false,
          lastCommit: sha || null,
        });
      }
    }
  }

  return c.json({ branches, currentBranch });
});

export { projects };
