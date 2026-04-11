import { mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const CONFIG_DIR_NAME = ".vibe-harness";

export function getConfigDir(): string {
  const dir = join(homedir(), CONFIG_DIR_NAME);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return dir;
}

// ── Port file ───────────────────────────────────────────────────────

const PORT_FILE = "daemon.port";

export function writePortFile(port: number): void {
  writeFileSync(join(getConfigDir(), PORT_FILE), String(port), { mode: 0o600 });
}

export function readPortFile(): number | null {
  try {
    const raw = readFileSync(join(getConfigDir(), PORT_FILE), "utf-8").trim();
    const port = parseInt(raw, 10);
    return Number.isNaN(port) ? null : port;
  } catch {
    return null;
  }
}

export function removePortFile(): void {
  try {
    unlinkSync(join(getConfigDir(), PORT_FILE));
  } catch {
    // already removed
  }
}

// ── PID file ────────────────────────────────────────────────────────

const PID_FILE = "daemon.pid";

export function writePidFile(): void {
  writeFileSync(join(getConfigDir(), PID_FILE), String(process.pid), {
    mode: 0o600,
  });
}

export function readPidFile(): number | null {
  try {
    const raw = readFileSync(join(getConfigDir(), PID_FILE), "utf-8").trim();
    const pid = parseInt(raw, 10);
    return Number.isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

export function removePidFile(): void {
  try {
    unlinkSync(join(getConfigDir(), PID_FILE));
  } catch {
    // already removed
  }
}

// ── Database path ───────────────────────────────────────────────────

export function getDbPath(): string {
  return join(getConfigDir(), "vibe-harness.db");
}
