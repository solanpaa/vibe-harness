import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateToken } from '../../src/lib/auth.js';

// We can't easily test getOrCreateToken without modifying the module's
// config dir. Instead, we replicate the token file logic with a temp dir
// and test generateToken + the file round-trip behavior directly.

const TEST_DIR = join(process.cwd(), '.test-auth-temp');

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('generateToken', () => {
  it('produces a 64-character hex string', () => {
    const token = generateToken();
    expect(token).toHaveLength(64);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces unique tokens on each call', () => {
    const t1 = generateToken();
    const t2 = generateToken();
    expect(t1).not.toBe(t2);
  });
});

describe('token file behavior', () => {
  it('round-trips token through file', async () => {
    const { writeFileSync } = await import('node:fs');
    const token = generateToken();
    const filePath = join(TEST_DIR, 'auth.token');

    writeFileSync(filePath, token, { mode: 0o600 });
    expect(existsSync(filePath)).toBe(true);

    const read = readFileSync(filePath, 'utf-8').trim();
    expect(read).toBe(token);
  });

  it('returns same token when file already exists', async () => {
    const { writeFileSync } = await import('node:fs');
    const token = generateToken();
    const filePath = join(TEST_DIR, 'auth.token');

    writeFileSync(filePath, token, { mode: 0o600 });

    // Second read should return the same token
    const read1 = readFileSync(filePath, 'utf-8').trim();
    const read2 = readFileSync(filePath, 'utf-8').trim();
    expect(read1).toBe(read2);
    expect(read1).toBe(token);
  });
});
