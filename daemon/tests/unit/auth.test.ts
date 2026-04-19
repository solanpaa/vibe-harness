import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// ── Test the real exported functions by pointing getConfigDir at a temp dir ──

const TEST_DIR = join(process.cwd(), '.test-auth-temp');

// Redirect config dir to our test directory
vi.mock('../../src/lib/config.js', () => ({
  getConfigDir: () => {
    const dir = join(process.cwd(), '.test-auth-temp');
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    return dir;
  },
}));

// Import AFTER the mock so the real auth module uses our test dir
const { generateToken, getOrCreateToken } = await import('../../src/lib/auth.js');

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

// ── generateToken contract ──────────────────────────────────────────

describe('generateToken', () => {
  it('returns a 64-character lowercase hex string (256 bits)', () => {
    const token = generateToken();
    expect(token).toHaveLength(64);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces cryptographically unique tokens across calls', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => generateToken()));
    expect(tokens.size).toBe(50);
  });
});

// ── getOrCreateToken contract ───────────────────────────────────────

describe('getOrCreateToken', () => {
  it('creates a token file when none exists and returns a valid token', () => {
    const tokenPath = join(TEST_DIR, 'auth.token');
    expect(existsSync(tokenPath)).toBe(false);

    const token = getOrCreateToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(tokenPath)).toBe(true);
  });

  it('returns the same token on subsequent calls (idempotent)', () => {
    const first = getOrCreateToken();
    const second = getOrCreateToken();
    expect(first).toBe(second);
  });

  it('persists token to disk so it survives across instances', () => {
    const token = getOrCreateToken();
    // Read directly from disk to verify persistence
    const onDisk = readFileSync(join(TEST_DIR, 'auth.token'), 'utf-8').trim();
    expect(onDisk).toBe(token);
  });

  it('creates token file with restrictive permissions (owner-only)', () => {
    getOrCreateToken();
    const stat = statSync(join(TEST_DIR, 'auth.token'));
    const perms = stat.mode & 0o777;
    expect(perms).toBe(0o600);
  });

  it('handles token file containing trailing whitespace', () => {
    writeFileSync(join(TEST_DIR, 'auth.token'), '  aabbccdd00112233aabbccdd00112233aabbccdd00112233aabbccdd00112233  \n');
    const token = getOrCreateToken();
    expect(token).toBe('aabbccdd00112233aabbccdd00112233aabbccdd00112233aabbccdd00112233');
  });
});
