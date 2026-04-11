import app from "./app.js";
import {
  getConfigDir,
  getDbPath,
  writePidFile,
  removePidFile,
  writePortFile,
  removePortFile,
} from "./lib/config.js";
import { getOrCreateToken } from "./lib/auth.js";
import { logger } from "./lib/logger.js";
import { getDb } from "./db/index.js";

// ── Startup ─────────────────────────────────────────────────────────

const configDir = getConfigDir();
logger.info({ configDir }, "Config directory ready");

const token = getOrCreateToken();
logger.info("Auth token ready");

const db = getDb(getDbPath());
logger.info("Database initialized");

writePidFile();
logger.info({ pid: process.pid }, "PID file written");

// Port file is written by Nitro's listen hook (see nitro.config.ts)
// but we also write a default here for safety
const DEFAULT_PORT = 3000;
writePortFile(parseInt(process.env.PORT ?? String(DEFAULT_PORT), 10));
logger.info("Port file written");

logger.info("Daemon ready");

// ── Shutdown ────────────────────────────────────────────────────────

let cleanedUp = false;

function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  removePidFile();
  removePortFile();
}

function shutdown(signal: string) {
  logger.info({ signal }, "Shutting down");
  cleanup();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
// Safety net: Nitro dev may intercept signals before our handlers fire
process.on("exit", () => cleanup());

export default app;
