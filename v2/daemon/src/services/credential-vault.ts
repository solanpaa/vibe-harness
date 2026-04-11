// ---------------------------------------------------------------------------
// Credential Vault Service (CDD §8)
//
// Encrypted credential storage, decryption, and sandbox injection.
// Values are AES-256-GCM encrypted. Plaintext values NEVER returned via API.
// ---------------------------------------------------------------------------

import { eq, desc } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import * as schema from '../db/schema.js';
import { encrypt, decrypt } from '../lib/encryption.js';
import { execCommand } from '../lib/shell.js';
import { logger } from '../lib/logger.js';
import { CredentialDecryptionError, CommandExtractError } from '../lib/errors.js';
import type { SandboxCredentials } from './sandbox.js';
import type { CredentialEntryType } from '@vibe-harness/shared';

// ── Types ──────────────────────────────────────────────────────────────

export interface CredentialSetInput {
  name: string;
  description?: string;
  projectId?: string | null;
}

export interface CredentialEntryInput {
  key: string;
  value: string;
  type: CredentialEntryType;
  mountPath?: string;
  command?: string;
}

// ── Audit logging ──────────────────────────────────────────────────────

function logAudit(action: string, opts?: {
  credentialSetId?: string | null;
  credentialEntryId?: string | null;
  workflowRunId?: string | null;
  details?: Record<string, unknown>;
}): void {
  try {
    const db = getDb();
    db.insert(schema.credentialAuditLog).values({
      action,
      credentialSetId: opts?.credentialSetId ?? null,
      credentialEntryId: opts?.credentialEntryId ?? null,
      workflowRunId: opts?.workflowRunId ?? null,
      details: opts?.details ? JSON.stringify(opts.details) : null,
    }).run();
  } catch {
    // Audit logging should never break credential operations
  }
}

// ── Credential Sets ────────────────────────────────────────────────────

export function createCredentialSet(input: CredentialSetInput) {
  const db = getDb();
  const credSet = db
    .insert(schema.credentialSets)
    .values({
      name: input.name,
      description: input.description ?? null,
      projectId: input.projectId ?? null,
    })
    .returning()
    .get();

  logAudit('created', {
    credentialSetId: credSet.id,
    details: { name: input.name },
  });

  return credSet;
}

export function getCredentialSet(id: string) {
  const db = getDb();
  return db
    .select()
    .from(schema.credentialSets)
    .where(eq(schema.credentialSets.id, id))
    .get();
}

export function listCredentialSets(projectId?: string) {
  const db = getDb();
  const query = db.select().from(schema.credentialSets);

  if (projectId) {
    return query.where(eq(schema.credentialSets.projectId, projectId)).all();
  }
  return query.all();
}

export function deleteCredentialSet(id: string) {
  const db = getDb();
  // Entries cascade-deleted via FK onDelete
  db.delete(schema.credentialSets)
    .where(eq(schema.credentialSets.id, id))
    .run();

  logAudit('deleted', { credentialSetId: id });
}

// ── Credential Entries ─────────────────────────────────────────────────

export function addCredentialEntry(setId: string, input: CredentialEntryInput) {
  const db = getDb();
  const encryptedValue = input.value ? encrypt(input.value) : '';

  const entry = db
    .insert(schema.credentialEntries)
    .values({
      credentialSetId: setId,
      key: input.key,
      value: encryptedValue,
      type: input.type,
      mountPath: input.mountPath ?? null,
      command: input.command ?? null,
    })
    .returning()
    .get();

  logAudit('created', {
    credentialSetId: setId,
    credentialEntryId: entry.id,
    details: { key: input.key, type: input.type },
  });

  // Return without the encrypted value (FR-C7)
  return {
    id: entry.id,
    credentialSetId: entry.credentialSetId,
    key: entry.key,
    type: entry.type,
    mountPath: entry.mountPath,
    command: entry.command,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

/** Get entries with values masked as '***' (FR-C7). */
export function getCredentialEntries(setId: string) {
  const db = getDb();
  const entries = db
    .select()
    .from(schema.credentialEntries)
    .where(eq(schema.credentialEntries.credentialSetId, setId))
    .all();

  return entries.map((e) => ({
    id: e.id,
    credentialSetId: e.credentialSetId,
    key: e.key,
    type: e.type as CredentialEntryType,
    mountPath: e.mountPath,
    command: e.command,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  }));
}

/** Get decrypted entries — ONLY for internal sandbox building. */
export function getDecryptedEntries(setId: string, workflowRunId?: string) {
  const db = getDb();
  const entries = db
    .select()
    .from(schema.credentialEntries)
    .where(eq(schema.credentialEntries.credentialSetId, setId))
    .all();

  logAudit('accessed', {
    credentialSetId: setId,
    workflowRunId,
    details: { entryCount: entries.length },
  });

  return entries.map((e) => {
    try {
      return {
        id: e.id,
        credentialSetId: e.credentialSetId,
        key: e.key,
        value: e.value ? decrypt(e.value) : '',
        type: e.type as CredentialEntryType,
        mountPath: e.mountPath,
        command: e.command,
        createdAt: e.createdAt,
        updatedAt: e.updatedAt,
      };
    } catch (err) {
      throw new CredentialDecryptionError(
        e.id,
        err instanceof Error ? err.message : String(err),
      );
    }
  });
}

export function deleteCredentialEntry(entryId: string) {
  const db = getDb();
  const entry = db
    .select()
    .from(schema.credentialEntries)
    .where(eq(schema.credentialEntries.id, entryId))
    .get();

  db.delete(schema.credentialEntries)
    .where(eq(schema.credentialEntries.id, entryId))
    .run();

  logAudit('deleted', {
    credentialSetId: entry?.credentialSetId,
    credentialEntryId: entryId,
    details: { key: entry?.key },
  });
}

// ── Build Sandbox Credentials ──────────────────────────────────────────

/**
 * Build SandboxCredentials from a credential set.
 * Handles all 5 entry types (SAD §6.2).
 */
export async function buildSandboxCredentials(
  credentialSetId: string,
  workflowRunId?: string,
): Promise<SandboxCredentials> {
  const log = logger.child({ credentialSetId, workflowRunId });
  const entries = getDecryptedEntries(credentialSetId, workflowRunId);

  const creds: SandboxCredentials = {
    envVars: [],
    fileMounts: [],
    dockerLogins: [],
    hostDirMounts: [],
  };

  for (const entry of entries) {
    switch (entry.type) {
      case 'env_var':
        creds.envVars.push({ key: entry.key, value: entry.value });
        break;

      case 'file_mount':
        if (!entry.mountPath) {
          log.warn({ entryId: entry.id }, 'file_mount entry missing mountPath, skipping');
          break;
        }
        creds.fileMounts.push({ mountPath: entry.mountPath, content: entry.value });
        break;

      case 'docker_login': {
        try {
          const parsed = JSON.parse(entry.value) as { username: string; password: string };
          creds.dockerLogins.push({
            registry: entry.key,
            username: parsed.username || '',
            password: parsed.password || '',
          });
        } catch {
          log.warn({ entryId: entry.id }, 'Invalid docker_login JSON, skipping');
        }
        break;
      }

      case 'host_dir_mount':
        if (!entry.mountPath) {
          log.warn({ entryId: entry.id }, 'host_dir_mount entry missing mountPath, skipping');
          break;
        }
        creds.hostDirMounts.push({
          hostPath: entry.value,
          containerPath: entry.mountPath,
        });
        break;

      case 'command_extract': {
        // ⚠️ SECURITY: command runs on HOST — trusted admin-only input (see CDD §8.3)
        if (!entry.command) {
          log.warn({ entryId: entry.id }, 'command_extract entry missing command, skipping');
          break;
        }
        log.info({ key: entry.key }, 'Running command extract on host');
        const result = await execCommand('sh', ['-c', entry.command], {
          timeout: 30_000,
        });
        if (result.exitCode !== 0) {
          throw new CommandExtractError(entry.key, entry.command, result.stderr);
        }
        creds.envVars.push({ key: entry.key, value: result.stdout.trim() });
        break;
      }
    }
  }

  // NEVER log credential values (FR-C8)
  log.info({
    envVarCount: creds.envVars.length,
    fileMountCount: creds.fileMounts.length,
    dockerLoginCount: creds.dockerLogins.length,
    hostDirMountCount: creds.hostDirMounts.length,
  }, 'Built sandbox credentials');

  return creds;
}

// ── Audit Log ──────────────────────────────────────────────────────────

export function getAuditLog(credentialSetId?: string) {
  const db = getDb();
  if (credentialSetId) {
    return db
      .select()
      .from(schema.credentialAuditLog)
      .where(eq(schema.credentialAuditLog.credentialSetId, credentialSetId))
      .orderBy(desc(schema.credentialAuditLog.createdAt))
      .all();
  }
  return db
    .select()
    .from(schema.credentialAuditLog)
    .orderBy(desc(schema.credentialAuditLog.createdAt))
    .all();
}

/** Get entry count for a credential set. */
export function getEntryCount(setId: string): number {
  const db = getDb();
  return db
    .select()
    .from(schema.credentialEntries)
    .where(eq(schema.credentialEntries.credentialSetId, setId))
    .all()
    .length;
}
