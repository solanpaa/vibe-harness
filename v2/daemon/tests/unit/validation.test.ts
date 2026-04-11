import { describe, it, expect } from 'vitest';
import { assertSafeRef, assertSafePath } from '../../src/lib/validation.js';
import { InvalidGitRefError, PathTraversalError } from '../../src/lib/errors.js';

// ── assertSafeRef ───────────────────────────────────────────────────

describe('assertSafeRef', () => {
  it('allows simple branch names', () => {
    expect(() => assertSafeRef('main')).not.toThrow();
    expect(() => assertSafeRef('develop')).not.toThrow();
  });

  it('allows slashed branch names', () => {
    expect(() => assertSafeRef('feature/foo')).not.toThrow();
    expect(() => assertSafeRef('release/v1.2.3')).not.toThrow();
  });

  it('allows version tags', () => {
    expect(() => assertSafeRef('v1.2.3')).not.toThrow();
    expect(() => assertSafeRef('v0.1.0-beta')).not.toThrow();
  });

  it('allows underscores', () => {
    expect(() => assertSafeRef('my_branch')).not.toThrow();
  });

  it('blocks empty strings', () => {
    expect(() => assertSafeRef('')).toThrow(InvalidGitRefError);
  });

  it('blocks whitespace-only strings', () => {
    expect(() => assertSafeRef('   ')).toThrow(InvalidGitRefError);
  });

  it('blocks backtick injection', () => {
    expect(() => assertSafeRef('main`rm -rf /`')).toThrow(InvalidGitRefError);
  });

  it('blocks dollar sign injection', () => {
    expect(() => assertSafeRef('main$(whoami)')).toThrow(InvalidGitRefError);
  });

  it('blocks semicolon injection', () => {
    expect(() => assertSafeRef('main;echo pwned')).toThrow(InvalidGitRefError);
  });

  it('blocks pipe injection', () => {
    expect(() => assertSafeRef('main|cat /etc/passwd')).toThrow(InvalidGitRefError);
  });

  it('blocks double-dot traversal', () => {
    expect(() => assertSafeRef('main..develop')).toThrow(InvalidGitRefError);
  });

  it('blocks dash-prefixed refs', () => {
    expect(() => assertSafeRef('-v')).toThrow(InvalidGitRefError);
    expect(() => assertSafeRef('--abort')).toThrow(InvalidGitRefError);
  });

  it('blocks newline injection', () => {
    expect(() => assertSafeRef('main\necho pwned')).toThrow(InvalidGitRefError);
  });

  it('blocks angle brackets', () => {
    expect(() => assertSafeRef('main<script>')).toThrow(InvalidGitRefError);
  });

  it('blocks curly braces', () => {
    expect(() => assertSafeRef('main{}')).toThrow(InvalidGitRefError);
  });

  it('blocks backslash', () => {
    expect(() => assertSafeRef('main\\path')).toThrow(InvalidGitRefError);
  });

  it('uses custom label in error messages', () => {
    try {
      assertSafeRef('', 'branch');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as Error).message).toContain('branch');
    }
  });
});

// ── assertSafePath ──────────────────────────────────────────────────

describe('assertSafePath', () => {
  it('allows paths within the base directory', () => {
    expect(() => assertSafePath('src/file.ts', '/project')).not.toThrow();
    expect(() => assertSafePath('nested/deep/file.txt', '/project')).not.toThrow();
  });

  it('allows relative paths that resolve within base', () => {
    expect(() => assertSafePath('./src/file.ts', '/project')).not.toThrow();
  });

  it('blocks path traversal with ../', () => {
    expect(() => assertSafePath('../../../etc/passwd', '/project')).toThrow(PathTraversalError);
  });

  it('blocks path traversal disguised in the middle', () => {
    expect(() => assertSafePath('src/../../etc/passwd', '/project')).toThrow(PathTraversalError);
  });

  it('allows deeply nested paths', () => {
    expect(() => assertSafePath('a/b/c/d/e/f.txt', '/base')).not.toThrow();
  });
});
