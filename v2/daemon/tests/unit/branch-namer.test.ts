import { describe, it, expect } from 'vitest';
import { createBranchNamer } from '../../src/services/branch-namer.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

function namer(llmCall?: (prompt: string) => Promise<string>) {
  return createBranchNamer({ logger, llmCall });
}

// ── sanitize ────────────────────────────────────────────────────────

describe('sanitize', () => {
  const { sanitize } = namer();

  it('lowercases and replaces spaces/underscores with hyphens', () => {
    expect(sanitize('Fix_Login Bug')).toBe('fix-login-bug');
  });

  it('removes special characters', () => {
    expect(sanitize('feat: add @email validation!')).toBe('feat-add-email-validation');
  });

  it('collapses consecutive hyphens', () => {
    expect(sanitize('a---b---c')).toBe('a-b-c');
  });

  it('collapses consecutive dots', () => {
    expect(sanitize('v1...2')).toBe('v1.2');
  });

  it('collapses consecutive slashes', () => {
    expect(sanitize('feature///branch')).toBe('feature/branch');
  });

  it('strips leading dashes, dots, slashes', () => {
    expect(sanitize('-.-/leading')).toBe('leading');
  });

  it('strips trailing dashes, dots, slashes', () => {
    expect(sanitize('trailing-.-/')).toBe('trailing');
  });

  it('enforces max length of 60', () => {
    const long = 'a'.repeat(100);
    expect(sanitize(long).length).toBeLessThanOrEqual(60);
  });

  it('handles empty string', () => {
    expect(sanitize('')).toBe('');
  });

  it('preserves valid git ref characters (alphanumeric, dot, hyphen, slash)', () => {
    expect(sanitize('feature/v1.2-beta')).toBe('feature/v1.2-beta');
  });
});

// ── deduplicate ─────────────────────────────────────────────────────

describe('deduplicate', () => {
  const { deduplicate } = namer();

  it('returns name unchanged when no conflict', () => {
    expect(deduplicate('my-branch', ['main', 'develop'])).toBe('my-branch');
  });

  it('appends -2 for first conflict', () => {
    expect(deduplicate('my-branch', ['my-branch'])).toBe('my-branch-2');
  });

  it('appends -3 when -2 already exists', () => {
    expect(deduplicate('feat', ['feat', 'feat-2'])).toBe('feat-3');
  });

  it('handles large chains', () => {
    const existing = Array.from({ length: 10 }, (_, i) =>
      i === 0 ? 'x' : `x-${i + 1}`,
    );
    // existing = ['x', 'x-2', 'x-3', ..., 'x-10']
    // Wait: Array.from with (_, 0) => 'x', (_, 1) => 'x-2' etc up to (_, 9) => 'x-10'
    // Actually need a cleaner approach
    const branches = ['x'];
    for (let i = 2; i <= 10; i++) branches.push(`x-${i}`);
    expect(deduplicate('x', branches)).toBe('x-11');
  });
});

// ── generate ────────────────────────────────────────────────────────

describe('generate', () => {
  it('uses slugified description when no LLM is provided', async () => {
    const bn = namer();
    const result = await bn.generate('Add user auth with JWT tokens', [], {
      prefix: 'vh',
      shortId: '12345678',
    });
    // Should be a sanitized slug from the description
    expect(result).toBe('add-user-auth-with-jwt-tokens');
  });

  it('falls back to prefix/shortId when description slugifies to empty', async () => {
    const bn = namer();
    const result = await bn.generate('!!!', [], {
      prefix: 'vh',
      shortId: 'abcd1234',
    });
    expect(result).toBe('vh/run-abcd1234');
  });

  it('deduplicates against existing branches', async () => {
    const bn = namer();
    const result = await bn.generate('fix bug', ['fix-bug'], {
      prefix: 'vh',
      shortId: 'aaa',
    });
    expect(result).toBe('fix-bug-2');
  });

  it('uses LLM result when available', async () => {
    const bn = namer(async () => 'add-jwt-auth');
    const result = await bn.generate('Add JWT authentication', [], {
      prefix: 'vh',
      shortId: 'aaa',
    });
    expect(result).toBe('add-jwt-auth');
  });

  it('falls back when LLM returns empty', async () => {
    const bn = namer(async () => '');
    const result = await bn.generate('Add feature', [], {
      prefix: 'vh',
      shortId: 'bbb',
    });
    // Should fall back to prefix/shortId
    expect(result).toBe('vh/run-bbb');
  });

  it('falls back when LLM throws', async () => {
    const bn = namer(async () => {
      throw new Error('LLM failed');
    });
    const result = await bn.generate('Some feature', [], {
      prefix: 'vh',
      shortId: 'ccc',
    });
    expect(result).toBe('some-feature');
  });

  it('sanitizes LLM output', async () => {
    const bn = namer(async () => '  Fix Login Bug!!!  ');
    const result = await bn.generate('whatever', [], {
      prefix: 'vh',
      shortId: 'ddd',
    });
    expect(result).toBe('fix-login-bug');
  });

  it('produces a valid git ref (no spaces, no special chars)', async () => {
    const bn = namer();
    const result = await bn.generate('My Cool Feature (v2) [WIP]', []);
    // Valid git ref pattern
    expect(result).toMatch(/^[a-z0-9.\-/]+$/);
    expect(result).not.toContain('..');
    expect(result).not.toContain('//');
    expect(result.length).toBeGreaterThan(0);
  });
});
