// ---------------------------------------------------------------------------
// Hook Resume Outbox Replayer (CDD-workflow §8)
//
// On startup, replays any pending hookResumes rows that were written to the
// outbox but never successfully delivered (crash between write and resume).
// ---------------------------------------------------------------------------

import { eq } from 'drizzle-orm';
import { resumeHook } from 'workflow/api';
import { getDb } from '../db/index.js';
import * as schema from '../db/schema.js';
import { logger } from './logger.js';

export async function replayPendingHookResumes(): Promise<void> {
  const db = getDb();
  const pending = db.select().from(schema.hookResumes).all();

  if (pending.length === 0) {
    logger.debug('No pending hook resumes to replay');
    return;
  }

  logger.info({ count: pending.length }, 'Replaying pending hook resumes');

  for (const row of pending) {
    try {
      const payload = JSON.parse(row.action);
      await resumeHook(row.hookToken, payload);

      db.delete(schema.hookResumes)
        .where(eq(schema.hookResumes.id, row.id))
        .run();

      logger.info({ hookToken: row.hookToken }, 'Hook resume replayed successfully');
    } catch (err) {
      logger.warn(
        { err, hookToken: row.hookToken, id: row.id },
        'Failed to replay hook resume, will retry on next startup',
      );
    }
  }
}
