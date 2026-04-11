// daemon/src/routes/credentials.ts — CDD §8 API routes

import { Hono } from 'hono';
import {
  createCredentialSet,
  getCredentialSet,
  listCredentialSets,
  deleteCredentialSet,
  addCredentialEntry,
  getCredentialEntries,
  deleteCredentialEntry,
  getAuditLog,
  getEntryCount,
} from '../services/credential-vault.js';
import {
  createCredentialSetSchema,
  createCredentialEntrySchema,
} from '../lib/validation/credentials.js';
import { logger } from '../lib/logger.js';

const credentials = new Hono();

// GET /api/credentials — list sets (with entryCount)
credentials.get('/api/credentials', (c) => {
  const projectId = c.req.query('projectId');
  const sets = listCredentialSets(projectId || undefined);
  const result = sets.map((s) => ({
    ...s,
    entryCount: getEntryCount(s.id),
  }));
  return c.json({ sets: result });
});

// POST /api/credentials — create set
credentials.post('/api/credentials', async (c) => {
  const body = await c.req.json();
  const parsed = createCredentialSetSchema.safeParse(body);

  if (!parsed.success) {
    return c.json(
      { error: { code: 'VALIDATION_ERROR', message: 'Invalid input', details: parsed.error.flatten() } },
      400,
    );
  }

  const credSet = createCredentialSet(parsed.data);
  logger.info({ credentialSetId: credSet.id, name: credSet.name }, 'Credential set created');
  return c.json(credSet, 201);
});

// GET /api/credentials/audit — audit log
// NOTE: must be registered BEFORE the /:id route to avoid "audit" matching :id
credentials.get('/api/credentials/audit', (c) => {
  const credentialSetId = c.req.query('credentialSetId');
  const entries = getAuditLog(credentialSetId || undefined);

  const parsed = entries.map((e) => ({
    ...e,
    details: e.details ? JSON.parse(e.details) : null,
  }));

  return c.json({ entries: parsed, total: parsed.length });
});

// GET /api/credentials/:id — get set detail with entries (masked)
credentials.get('/api/credentials/:id', (c) => {
  const id = c.req.param('id');
  const credSet = getCredentialSet(id);

  if (!credSet) {
    return c.json(
      { error: { code: 'CREDENTIAL_SET_NOT_FOUND', message: 'Credential set not found' } },
      404,
    );
  }

  const entries = getCredentialEntries(id);
  return c.json({ set: credSet, entries });
});

// DELETE /api/credentials/:id — delete set (cascades entries)
credentials.delete('/api/credentials/:id', (c) => {
  const id = c.req.param('id');
  const credSet = getCredentialSet(id);

  if (!credSet) {
    return c.json(
      { error: { code: 'CREDENTIAL_SET_NOT_FOUND', message: 'Credential set not found' } },
      404,
    );
  }

  deleteCredentialSet(id);
  logger.info({ credentialSetId: id }, 'Credential set deleted');
  return c.body(null, 204);
});

// POST /api/credentials/:id/entries — add entry to set
credentials.post('/api/credentials/:id/entries', async (c) => {
  const setId = c.req.param('id');
  const credSet = getCredentialSet(setId);

  if (!credSet) {
    return c.json(
      { error: { code: 'CREDENTIAL_SET_NOT_FOUND', message: 'Credential set not found' } },
      404,
    );
  }

  const body = await c.req.json();
  const parsed = createCredentialEntrySchema.safeParse(body);

  if (!parsed.success) {
    return c.json(
      { error: { code: 'VALIDATION_ERROR', message: 'Invalid input', details: parsed.error.flatten() } },
      400,
    );
  }

  const entry = addCredentialEntry(setId, parsed.data);
  logger.info({ credentialSetId: setId, entryId: entry.id, key: entry.key }, 'Credential entry added');
  return c.json(entry, 201);
});

// DELETE /api/credentials/:id/entries/:entryId — delete entry
credentials.delete('/api/credentials/:id/entries/:entryId', (c) => {
  const entryId = c.req.param('entryId');
  deleteCredentialEntry(entryId);
  logger.info({ entryId }, 'Credential entry deleted');
  return c.body(null, 204);
});

export { credentials };
