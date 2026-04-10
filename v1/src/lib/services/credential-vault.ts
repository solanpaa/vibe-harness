import { getDb, schema } from "@/lib/db";
import { encrypt, decrypt } from "@/lib/utils/encryption";
import { eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import type { CredentialEntryType } from "@/types/domain";

async function logAudit(action: string, opts?: {
  credentialSetId?: string;
  credentialEntryId?: string;
  taskId?: string;
  details?: Record<string, unknown>;
}) {
  try {
    const db = await getDb();
    await db.insert(schema.credentialAuditLog).values({
      id: uuid(),
      action,
      credentialSetId: opts?.credentialSetId || null,
      credentialEntryId: opts?.credentialEntryId || null,
      taskId: opts?.taskId || null,
      details: opts?.details ? JSON.stringify(opts.details) : null,
      createdAt: new Date().toISOString(),
    }).run();
  } catch {
    // Audit logging should never break credential operations
  }
}

export interface CredentialSetInput {
  name: string;
  description?: string;
  projectId?: string | null;
}

export interface CredentialEntryInput {
  credentialSetId: string;
  key: string;
  value: string; // plaintext — will be encrypted
  type: CredentialEntryType;
  mountPath?: string | null;
}

export async function createCredentialSet(input: CredentialSetInput) {
  const db = await getDb();
  const now = new Date().toISOString();
  const credSet = {
    id: uuid(),
    name: input.name,
    description: input.description || null,
    projectId: input.projectId || null,
    createdAt: now,
  };
  await db.insert(schema.credentialSets).values(credSet).run();
  await logAudit("create_set", { credentialSetId: credSet.id, details: { name: input.name } });
  return credSet;
}

export async function addCredentialEntry(input: CredentialEntryInput) {
  const db = await getDb();
  const now = new Date().toISOString();
  const entry = {
    id: uuid(),
    credentialSetId: input.credentialSetId,
    key: input.key,
    value: encrypt(input.value),
    type: input.type,
    mountPath: input.mountPath || null,
    createdAt: now,
  };
  await db.insert(schema.credentialEntries).values(entry).run();
  await logAudit("add_entry", {
    credentialSetId: input.credentialSetId,
    credentialEntryId: entry.id,
    details: { key: input.key, type: input.type },
  });
  return { ...entry, value: "***" }; // never return encrypted value to client
}

export async function getCredentialEntries(credentialSetId: string) {
  const db = await getDb();
  const entries = await db
    .select()
    .from(schema.credentialEntries)
    .where(eq(schema.credentialEntries.credentialSetId, credentialSetId))
    .all();
  return entries.map((e) => ({ ...e, value: "***" }));
}

export async function getDecryptedEntries(credentialSetId: string) {
  const db = await getDb();
  const entries = await db
    .select()
    .from(schema.credentialEntries)
    .where(eq(schema.credentialEntries.credentialSetId, credentialSetId))
    .all();
  return entries.map((e) => ({ ...e, value: decrypt(e.value) }));
}

export async function deleteCredentialEntry(entryId: string) {
  const db = await getDb();
  const entry = await db.select().from(schema.credentialEntries)
    .where(eq(schema.credentialEntries.id, entryId)).get();
  await db.delete(schema.credentialEntries)
    .where(eq(schema.credentialEntries.id, entryId))
    .run();
  await logAudit("delete_entry", {
    credentialSetId: entry?.credentialSetId,
    credentialEntryId: entryId,
    details: { key: entry?.key },
  });
}

/** Build env vars and mount args for Docker sandbox from a credential set */
export async function buildSandboxCredentials(credentialSetId: string, taskId?: string): Promise<{
  envVars: Record<string, string>;
  fileMounts: Array<{ key: string; value: string; mountPath: string }>;
  dockerLogins: Array<{ registry: string; username: string; password: string }>;
}> {
  const entries = await getDecryptedEntries(credentialSetId);
  const envVars: Record<string, string> = {};
  const fileMounts: Array<{ key: string; value: string; mountPath: string }> = [];
  const dockerLogins: Array<{ registry: string; username: string; password: string }> = [];

  for (const entry of entries) {
    switch (entry.type) {
      case "env_var":
        envVars[entry.key] = entry.value;
        break;
      case "file_mount":
        if (entry.mountPath) {
          fileMounts.push({
            key: entry.key,
            value: entry.value,
            mountPath: entry.mountPath,
          });
        }
        break;
      case "docker_login": {
        // Value is JSON: { "username": "...", "password": "..." }
        try {
          const parsed = JSON.parse(entry.value);
          dockerLogins.push({
            registry: entry.key,
            username: parsed.username || "",
            password: parsed.password || "",
          });
        } catch {
          console.warn(`[credential-vault] Invalid docker_login JSON for entry ${entry.key}`);
        }
        break;
      }
    }
  }

  await logAudit("access", {
    credentialSetId,
    taskId,
    details: {
      envVarCount: Object.keys(envVars).length,
      fileMountCount: fileMounts.length,
      dockerLoginCount: dockerLogins.length,
    },
  });

  return { envVars, fileMounts, dockerLogins };
}

/** Get audit log entries for a credential set */
export async function getAuditLog(credentialSetId?: string) {
  const db = await getDb();
  if (credentialSetId) {
    return await db.select().from(schema.credentialAuditLog)
      .where(eq(schema.credentialAuditLog.credentialSetId, credentialSetId))
      .all();
  }
  return await db.select().from(schema.credentialAuditLog).all();
}
