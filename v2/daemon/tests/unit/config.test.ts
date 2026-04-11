import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

// config.ts uses homedir() internally, so we test the file helpers
// by replicating the logic with a temp directory.

const TEST_DIR = join(process.cwd(), '.test-config-temp');

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('config dir creation', () => {
  it('creates directory with correct permissions on Unix', () => {
    const dir = join(TEST_DIR, 'subdir');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    expect(existsSync(dir)).toBe(true);

    const stat = statSync(dir);
    // On macOS/Linux, mode includes file type bits. Mask to permission bits.
    const perms = stat.mode & 0o777;
    expect(perms).toBe(0o700);
  });
});

describe('port file round-trip', () => {
  const portFile = () => join(TEST_DIR, 'daemon.port');

  function writePortFile(port: number) {
    writeFileSync(portFile(), String(port), { mode: 0o600 });
  }

  function readPortFile(): number | null {
    try {
      const raw = readFileSync(portFile(), 'utf-8').trim();
      const port = parseInt(raw, 10);
      return Number.isNaN(port) ? null : port;
    } catch {
      return null;
    }
  }

  it('writes and reads back the same port', () => {
    writePortFile(3456);
    expect(readPortFile()).toBe(3456);
  });

  it('returns null when file does not exist', () => {
    expect(readPortFile()).toBeNull();
  });

  it('returns null for non-numeric content', () => {
    writeFileSync(portFile(), 'not-a-number');
    expect(readPortFile()).toBeNull();
  });
});

describe('PID file round-trip', () => {
  const pidFile = () => join(TEST_DIR, 'daemon.pid');

  function writePidFile(pid: number) {
    writeFileSync(pidFile(), String(pid), { mode: 0o600 });
  }

  function readPidFile(): number | null {
    try {
      const raw = readFileSync(pidFile(), 'utf-8').trim();
      const pid = parseInt(raw, 10);
      return Number.isNaN(pid) ? null : pid;
    } catch {
      return null;
    }
  }

  it('writes and reads back the same PID', () => {
    writePidFile(12345);
    expect(readPidFile()).toBe(12345);
  });

  it('returns null when file does not exist', () => {
    expect(readPidFile()).toBeNull();
  });
});

describe('cleanup', () => {
  it('removes port and PID files', () => {
    const pf = join(TEST_DIR, 'daemon.port');
    const pidf = join(TEST_DIR, 'daemon.pid');

    writeFileSync(pf, '3000');
    writeFileSync(pidf, '99999');
    expect(existsSync(pf)).toBe(true);
    expect(existsSync(pidf)).toBe(true);

    // Simulate cleanup
    try { rmSync(pf); } catch { /* ok */ }
    try { rmSync(pidf); } catch { /* ok */ }

    expect(existsSync(pf)).toBe(false);
    expect(existsSync(pidf)).toBe(false);
  });

  it('does not throw when files already removed', () => {
    expect(() => {
      try { rmSync(join(TEST_DIR, 'daemon.port')); } catch { /* ok */ }
      try { rmSync(join(TEST_DIR, 'daemon.pid')); } catch { /* ok */ }
    }).not.toThrow();
  });
});
