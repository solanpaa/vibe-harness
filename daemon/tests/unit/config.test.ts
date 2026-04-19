import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, existsSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// ── Redirect config dir to a test temp dir ──────────────────────────

const TEST_DIR = join(process.cwd(), '.test-config-temp');

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return { ...actual, homedir: () => join(process.cwd(), '.test-config-temp', 'home') };
});

// Import AFTER mock so the real config module uses our homedir
const {
  getConfigDir,
  writePortFile,
  readPortFile,
  removePortFile,
  writePidFile,
  readPidFile,
  removePidFile,
  getDbPath,
} = await import('../../src/lib/config.js');

beforeEach(() => {
  mkdirSync(join(TEST_DIR, 'home'), { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

// ── getConfigDir contract ───────────────────────────────────────────

describe('getConfigDir', () => {
  it('creates the config directory if it does not exist', () => {
    const dir = getConfigDir();
    expect(existsSync(dir)).toBe(true);
    expect(dir).toContain('.vibe-harness');
  });

  it('returns the same path on repeated calls (idempotent)', () => {
    const a = getConfigDir();
    const b = getConfigDir();
    expect(a).toBe(b);
  });

  it('creates directory with owner-only permissions (0o700)', () => {
    const dir = getConfigDir();
    const perms = statSync(dir).mode & 0o777;
    expect(perms).toBe(0o700);
  });
});

// ── Port file contract ──────────────────────────────────────────────

describe('writePortFile / readPortFile', () => {
  it('round-trips a port number', () => {
    writePortFile(3456);
    expect(readPortFile()).toBe(3456);
  });

  it('overwrites previous port on second write', () => {
    writePortFile(3000);
    writePortFile(4000);
    expect(readPortFile()).toBe(4000);
  });

  it('returns null when no port file exists', () => {
    expect(readPortFile()).toBeNull();
  });

  it('returns null when port file contains non-numeric content', () => {
    // Simulate corrupted file
    writeFileSync(join(getConfigDir(), 'daemon.port'), 'garbage');
    expect(readPortFile()).toBeNull();
  });

  it('returns null when port file is empty', () => {
    writeFileSync(join(getConfigDir(), 'daemon.port'), '');
    expect(readPortFile()).toBeNull();
  });
});

// ── removePortFile contract ─────────────────────────────────────────

describe('removePortFile', () => {
  it('removes an existing port file', () => {
    writePortFile(3000);
    expect(readPortFile()).toBe(3000);
    removePortFile();
    expect(readPortFile()).toBeNull();
  });

  it('does not throw when port file already absent', () => {
    expect(() => removePortFile()).not.toThrow();
  });
});

// ── PID file contract ───────────────────────────────────────────────

describe('writePidFile / readPidFile', () => {
  it('writes current process PID and reads it back', () => {
    writePidFile();
    expect(readPidFile()).toBe(process.pid);
  });

  it('returns null when no PID file exists', () => {
    expect(readPidFile()).toBeNull();
  });
});

describe('removePidFile', () => {
  it('removes an existing PID file', () => {
    writePidFile();
    removePidFile();
    expect(readPidFile()).toBeNull();
  });

  it('does not throw when PID file already absent', () => {
    expect(() => removePidFile()).not.toThrow();
  });
});

// ── getDbPath contract ──────────────────────────────────────────────

describe('getDbPath', () => {
  it('returns a path ending in vibe-harness.db inside config dir', () => {
    const dbPath = getDbPath();
    expect(dbPath).toContain('.vibe-harness');
    expect(dbPath).toMatch(/vibe-harness\.db$/);
  });

  it('returns consistent path across calls', () => {
    expect(getDbPath()).toBe(getDbPath());
  });
});
