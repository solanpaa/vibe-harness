import { describe, it, expect } from 'vitest';
import { parseUnifiedDiff, diffSummary, type DiffFile } from '../../src/services/diff-parser.js';

// ── Helpers ─────────────────────────────────────────────────────────

/** Join lines into a unified diff string (trailing newline like real git) */
function diff(...lines: string[]): string {
  return lines.join('\n') + '\n';
}

// ── Tests ───────────────────────────────────────────────────────────

describe('parseUnifiedDiff', () => {
  it('parses a simple added file', () => {
    const input = diff(
      'diff --git a/hello.txt b/hello.txt',
      'new file mode 100644',
      'index 0000000..e965047',
      '--- /dev/null',
      '+++ b/hello.txt',
      '@@ -0,0 +1,3 @@',
      '+line 1',
      '+line 2',
      '+line 3',
    );

    const files = parseUnifiedDiff(input);
    expect(files).toHaveLength(1);
    expect(files[0].status).toBe('added');
    expect(files[0].oldPath).toBeNull();
    expect(files[0].newPath).toBe('hello.txt');
    expect(files[0].additions).toBe(3);
    expect(files[0].deletions).toBe(0);
    expect(files[0].isBinary).toBe(false);
  });

  it('parses a simple modified file with adds and deletes', () => {
    const input = diff(
      'diff --git a/src/app.ts b/src/app.ts',
      'index abc1234..def5678 100644',
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -1,5 +1,6 @@',
      ' import { Hono } from "hono";',
      '-import { old } from "./old.js";',
      '+import { new1 } from "./new1.js";',
      '+import { new2 } from "./new2.js";',
      ' ',
      ' const app = new Hono();',
    );

    const files = parseUnifiedDiff(input);
    expect(files).toHaveLength(1);
    expect(files[0].status).toBe('modified');
    expect(files[0].oldPath).toBe('src/app.ts');
    expect(files[0].newPath).toBe('src/app.ts');
    expect(files[0].additions).toBe(2);
    expect(files[0].deletions).toBe(1);
  });

  it('parses a deleted file', () => {
    const input = diff(
      'diff --git a/old.ts b/old.ts',
      'deleted file mode 100644',
      'index abc1234..0000000',
      '--- a/old.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-line 1',
      '-line 2',
    );

    const files = parseUnifiedDiff(input);
    expect(files).toHaveLength(1);
    expect(files[0].status).toBe('deleted');
    expect(files[0].oldPath).toBe('old.ts');
    expect(files[0].newPath).toBeNull();
    expect(files[0].additions).toBe(0);
    expect(files[0].deletions).toBe(2);
  });

  it('parses renamed files', () => {
    const input = diff(
      'diff --git a/old-name.ts b/new-name.ts',
      'similarity index 100%',
      'rename from old-name.ts',
      'rename to new-name.ts',
    );

    const files = parseUnifiedDiff(input);
    expect(files).toHaveLength(1);
    expect(files[0].status).toBe('renamed');
    expect(files[0].oldPath).toBe('old-name.ts');
    expect(files[0].newPath).toBe('new-name.ts');
    expect(files[0].additions).toBe(0);
    expect(files[0].deletions).toBe(0);
  });

  it('detects binary files', () => {
    const input = diff(
      'diff --git a/image.png b/image.png',
      'new file mode 100644',
      'index 0000000..abc1234',
      'Binary files /dev/null and b/image.png differ',
    );

    const files = parseUnifiedDiff(input);
    expect(files).toHaveLength(1);
    expect(files[0].isBinary).toBe(true);
    expect(files[0].hunks).toHaveLength(0);
  });

  it('returns empty array for empty input', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
  });

  it('returns empty array for whitespace-only input', () => {
    expect(parseUnifiedDiff('  \n\n  ')).toEqual([]);
  });

  it('correctly tracks line numbers in hunks', () => {
    const input = diff(
      'diff --git a/file.ts b/file.ts',
      'index abc..def 100644',
      '--- a/file.ts',
      '+++ b/file.ts',
      '@@ -10,4 +10,5 @@ function foo() {',
      ' context line',
      '-old line',
      '+new line 1',
      '+new line 2',
      ' more context',
    );

    const files = parseUnifiedDiff(input);
    const hunk = files[0].hunks[0];

    expect(hunk.oldStart).toBe(10);
    expect(hunk.oldCount).toBe(4);
    expect(hunk.newStart).toBe(10);
    expect(hunk.newCount).toBe(5);
    expect(hunk.context).toBe('function foo() {');

    // context line at old:10, new:10
    expect(hunk.lines[0]).toMatchObject({
      type: 'context',
      oldLineNumber: 10,
      newLineNumber: 10,
    });
    // deleted line at old:11
    expect(hunk.lines[1]).toMatchObject({
      type: 'delete',
      oldLineNumber: 11,
      newLineNumber: null,
    });
    // added lines at new:11, new:12
    expect(hunk.lines[2]).toMatchObject({
      type: 'add',
      oldLineNumber: null,
      newLineNumber: 11,
    });
    expect(hunk.lines[3]).toMatchObject({
      type: 'add',
      oldLineNumber: null,
      newLineNumber: 12,
    });
    // context at old:12, new:13
    expect(hunk.lines[4]).toMatchObject({
      type: 'context',
      oldLineNumber: 12,
      newLineNumber: 13,
    });
  });

  it('handles multiple files in a single diff', () => {
    const input = diff(
      'diff --git a/a.ts b/a.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/a.ts',
      '@@ -0,0 +1 @@',
      '+hello',
      'diff --git a/b.ts b/b.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/b.ts',
      '@@ -0,0 +1 @@',
      '+world',
    );

    const files = parseUnifiedDiff(input);
    expect(files).toHaveLength(2);
    expect(files[0].newPath).toBe('a.ts');
    expect(files[1].newPath).toBe('b.ts');
  });

  it('handles the phantom EOF fix — no extra context line from trailing newline', () => {
    // Git output always ends with \n. Without the EOF fix, split produces
    // a trailing empty string that could be misinterpreted as a context line.
    const input = 'diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -1 +1 @@\n-old\n+new\n';

    const files = parseUnifiedDiff(input);
    expect(files).toHaveLength(1);
    const lines = files[0].hunks[0].lines;
    // Should have exactly 2 lines (delete + add), no phantom context
    expect(lines).toHaveLength(2);
    expect(lines[0].type).toBe('delete');
    expect(lines[1].type).toBe('add');
  });

  it('handles "No newline at end of file" markers', () => {
    const input = diff(
      'diff --git a/f.txt b/f.txt',
      '--- a/f.txt',
      '+++ b/f.txt',
      '@@ -1 +1 @@',
      '-old',
      '\\ No newline at end of file',
      '+new',
      '\\ No newline at end of file',
    );

    const files = parseUnifiedDiff(input);
    const lines = files[0].hunks[0].lines;
    expect(lines).toHaveLength(2);
    expect(lines.every(l => l.type === 'delete' || l.type === 'add')).toBe(true);
  });

  it('parses multiple hunks in a single file', () => {
    const input = diff(
      'diff --git a/big.ts b/big.ts',
      '--- a/big.ts',
      '+++ b/big.ts',
      '@@ -1,3 +1,3 @@',
      ' first',
      '-old1',
      '+new1',
      ' third',
      '@@ -20,3 +20,3 @@',
      ' before',
      '-old2',
      '+new2',
      ' after',
    );

    const files = parseUnifiedDiff(input);
    expect(files).toHaveLength(1);
    expect(files[0].hunks).toHaveLength(2);
    expect(files[0].hunks[0].oldStart).toBe(1);
    expect(files[0].hunks[1].oldStart).toBe(20);
    expect(files[0].additions).toBe(2);
    expect(files[0].deletions).toBe(2);
  });
});

describe('diffSummary', () => {
  it('generates a human-readable summary', () => {
    const files: DiffFile[] = [
      {
        oldPath: null,
        newPath: 'new.ts',
        status: 'added',
        isBinary: false,
        hunks: [],
        additions: 10,
        deletions: 0,
      },
      {
        oldPath: 'old.ts',
        newPath: 'old.ts',
        status: 'modified',
        isBinary: false,
        hunks: [],
        additions: 5,
        deletions: 3,
      },
    ];

    const summary = diffSummary(files);
    expect(summary).toContain('2 file(s) changed');
    expect(summary).toContain('15 insertions(+)');
    expect(summary).toContain('3 deletions(-)');
    expect(summary).toContain('+ new.ts');
    expect(summary).toContain('~ old.ts');
  });

  it('shows minus prefix for deleted files', () => {
    const files: DiffFile[] = [
      {
        oldPath: 'removed.ts',
        newPath: null,
        status: 'deleted',
        isBinary: false,
        hunks: [],
        additions: 0,
        deletions: 5,
      },
    ];

    const summary = diffSummary(files);
    expect(summary).toContain('- removed.ts');
  });
});
