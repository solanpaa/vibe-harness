import { getDb, schema } from "@/lib/db";
import { encrypt, decrypt } from "@/lib/utils/encryption";
import { eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import type { CredentialEntryType } from "@/types/domain";

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
}

export function createCredentialSet(input: CredentialSetInput) {
  const db = getDb();
  const now = new Date().toISOString();
  const credSet = {
    id: uuid(),
    name: input.name,
    description: input.description || null,
    projectId: input.projectId || null,
    createdAt: now,
  };
  db.insert(schema.credentialSets).values(credSet).run();
  return credSet;
}

export function addCredentialEntry(input: CredentialEntryInput) {
  const db = getDb();
  const now = new Date().toISOString();
  const entry = {
    id: uuid(),
    credentialSetId: input.credentialSetId,
    key: input.key,
    value: encrypt(input.value),
    type: input.type,
    createdAt: now,
  };
  db.insert(schema.credentialEntries).values(entry).run();
  return { ...entry, value: "***" }; // never return encrypted value to client
}

export function getCredentialEntries(credentialSetId: string) {
  const db = getDb();
  const entries = db
    .select()
    .from(schema.credentialEntries)
    .where(eq(schema.credentialEntries.credentialSetId, credentialSetId))
    .all();
  return entries.map((e) => ({ ...e, value: "***" }));
}

export function getDecryptedEntries(credentialSetId: string) {
  const db = getDb();
  const entries = db
    .select()
    .from(schema.credentialEntries)
    .where(eq(schema.credentialEntries.credentialSetId, credentialSetId))
    .all();
  return entries.map((e) => ({ ...e, value: decrypt(e.value) }));
}

export function deleteCredentialEntry(entryId: string) {
  const db = getDb();
  db.delete(schema.credentialEntries)
    .where(eq(schema.credentialEntries.id, entryId))
    .run();
}

/** Build env vars and mount args for Docker sandbox from a credential set */
export function buildSandboxCredentials(credentialSetId: string): {
  envVars: Record<string, string>;
  fileMounts: Array<{ key: string; value: string }>;
  dockerLogins: Array<{ key: string; value: string }>;
} {
  const entries = getDecryptedEntries(credentialSetId);
  const envVars: Record<string, string> = {};
  const fileMounts: Array<{ key: string; value: string }> = [];
  const dockerLogins: Array<{ key: string; value: string }> = [];

  for (const entry of entries) {
    switch (entry.type) {
      case "env_var":
        envVars[entry.key] = entry.value;
        break;
      case "file_mount":
        fileMounts.push({ key: entry.key, value: entry.value });
        break;
      case "docker_login":
        dockerLogins.push({ key: entry.key, value: entry.value });
        break;
    }
  }

  return { envVars, fileMounts, dockerLogins };
}
