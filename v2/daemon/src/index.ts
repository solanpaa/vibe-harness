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
import { replayPendingHookResumes } from "./lib/reconcile.js";

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

// Replay any pending hook resumes from the outbox (crash recovery)
replayPendingHookResumes().catch((err) => {
  logger.error({ err }, "Failed to replay pending hook resumes");
});

writePidFile();
logger.info({ pid: process.pid }, "PID file written");

// NOTE: Port file should ideally be written from Nitro's "listen" callback
// once the server has actually bound to a port. Nitro 3 alpha does not
// currently expose a reliable post-bind hook, so we defer briefly to
// avoid writing the file before the socket is ready.
// TODO: Replace with Nitro listen hook when available.
const DEFAULT_PORT = 3000;
const port = parseInt(process.env.PORT ?? String(DEFAULT_PORT), 10);
setTimeout(() => {
  writePortFile(port);
  logger.info({ port }, "Port file written (deferred)");
}, 500);

logger.info("Daemon ready");

// ── Shutdown ────────────────────────────────────────────────────────

let cleanedUp = false;

async function cleanup(): Promise<void> {
  if (cleanedUp) return;
  cleanedUp = true;

  // TODO: Stop accepting new connections
  // TODO: Close WebSocket connections
  // TODO: Stop running sandboxes

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
