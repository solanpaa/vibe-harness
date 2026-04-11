import app from "./app.js";
import {
  getConfigDir,
  getDbPath,
  writePidFile,
  readPidFile,
  removePidFile,
  writePortFile,
  removePortFile,
} from "./lib/config.js";
import { getOrCreateToken } from "./lib/auth.js";
import { logger } from "./lib/logger.js";
import { getDb, closeDb } from "./db/index.js";
import { eq, and, inArray } from 'drizzle-orm';
import * as schema from "./db/schema.js";
import { reconcileOnStartup } from "./lib/reconcile.js";
import { createSandboxService, type SandboxService } from "./services/sandbox.js";
import * as streamingService from "./services/streaming-service.js";

// ── Single-instance guard ───────────────────────────────────────────

function ensureSingleInstance(): void {
  const existingPid = readPidFile();
  if (existingPid !== null) {
    try {
      process.kill(existingPid, 0); // signal 0 = alive check
      logger.error(
        { existingPid },
        "Another daemon instance is already running. Exiting.",
      );
      process.exit(1);
    } catch {
      // Process not alive — stale PID file, remove and continue
      logger.warn({ stalePid: existingPid }, "Removing stale PID file");
      removePidFile();
    }
  }
}

// ── Startup ─────────────────────────────────────────────────────────

const configDir = getConfigDir();
logger.info({ configDir }, "Config directory ready");

ensureSingleInstance();

const token = getOrCreateToken();
logger.info("Auth token ready");

const db = getDb(getDbPath());
logger.info("Database initialized");

// Create sandbox service for reconciliation and shutdown
const sandboxService: SandboxService = createSandboxService({ logger });

// Startup reconciliation (SAD §2.1.3): mark crashed runs as failed,
// stop orphaned sandboxes, replay pending hook resumes.
// Awaited before serving so clients never see stale in-flight state.
const DEFAULT_PORT = 3000;
const port = parseInt(process.env.PORT ?? String(DEFAULT_PORT), 10);

reconcileOnStartup(sandboxService)
  .catch((err) => {
    logger.error({ err }, "Startup reconciliation failed");
  })
  .then(() => {
    writePidFile();
    logger.info({ pid: process.pid }, "PID file written");

    // NOTE: Port file should ideally be written from Nitro's "listen" callback
    // once the server has actually bound to a port. Nitro 3 alpha does not
    // currently expose a reliable post-bind hook, so we defer briefly to
    // avoid writing the file before the socket is ready.
    // TODO: Replace with Nitro listen hook when available.
    setTimeout(() => {
      writePortFile(port);
      logger.info({ port }, "Port file written (deferred)");
    }, 500);

    logger.info("Daemon ready");
  });

// ── Shutdown ────────────────────────────────────────────────────────

let cleanedUp = false;

async function cleanup(): Promise<void> {
  if (cleanedUp) return;
  cleanedUp = true;

  // Mark active workflow runs as stage_failed so next startup doesn't re-reconcile
  try {
    const db = getDb();
    const now = new Date().toISOString();
    const activeRuns = db
      .select()
      .from(schema.workflowRuns)
      .where(inArray(schema.workflowRuns.status, ['running', 'provisioning']))
      .all();

    for (const run of activeRuns) {
      const runningStage = db
        .select()
        .from(schema.stageExecutions)
        .where(and(
          eq(schema.stageExecutions.workflowRunId, run.id),
          eq(schema.stageExecutions.status, 'running'),
        ))
        .all()[0];

      if (runningStage) {
        db.update(schema.stageExecutions)
          .set({ status: 'failed', failureReason: 'daemon_shutdown', completedAt: now })
          .where(eq(schema.stageExecutions.id, runningStage.id))
          .run();
      }

      db.update(schema.workflowRuns)
        .set({ status: 'stage_failed' })
        .where(eq(schema.workflowRuns.id, run.id))
        .run();
    }

    if (activeRuns.length > 0) {
      logger.info({ count: activeRuns.length }, "Marked active runs as stage_failed on shutdown");
    }
  } catch (err) {
    logger.error({ err }, "Error marking runs on shutdown");
  }

  // Stop all active sandboxes
  try {
    const liveSandboxes = await sandboxService.list();
    for (const sandbox of liveSandboxes) {
      try {
        await sandboxService.forceStop(sandbox.name);
      } catch (err) {
        logger.warn({ err, sandbox: sandbox.name }, "Failed to stop sandbox during shutdown");
      }
    }
    logger.info({ count: liveSandboxes.length }, "Active sandboxes stopped");
  } catch (err) {
    logger.error({ err }, "Error stopping sandboxes during shutdown");
  }

  // Disconnect all WebSocket clients and flush streaming buffers
  try {
    streamingService.disconnectAll();
  } catch (err) {
    logger.error({ err }, "Error disconnecting streaming clients");
  }

  // Close database
  try {
    closeDb();
    logger.info("Database closed");
  } catch (err) {
    logger.error({ err }, "Error closing database");
  }

  removePidFile();
  removePortFile();
}

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, "Shutting down");
  await cleanup();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
// Safety net: synchronous best-effort on unexpected exit
process.on("exit", () => {
  if (!cleanedUp) {
    try { closeDb(); } catch { /* best effort */ }
    removePidFile();
    removePortFile();
  }
});

export default app;
