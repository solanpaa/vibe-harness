// ---------------------------------------------------------------------------
// Diff Parser (CDD §10)
//
// Pure-function parser for unified diff text → structured DiffFile[].
// No dependencies — used by WorktreeService and ReviewService.
// ---------------------------------------------------------------------------

// ── Types ────────────────────────────────────────────────────────────

export type DiffLineType = 'add' | 'delete' | 'context';

export interface DiffLine {
  type: DiffLineType;
  content: string;
  oldLineNumber: number | null;
  newLineNumber: number | null;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  context?: string;
  lines: DiffLine[];
}

export type DiffFileStatus = 'added' | 'deleted' | 'modified' | 'renamed';

export interface DiffFile {
  oldPath: string | null;
  newPath: string | null;
  status: DiffFileStatus;
  isBinary: boolean;
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
}

// ── Parser ───────────────────────────────────────────────────────────

/**
 * Parse unified diff text (git diff output) into structured DiffFile[].
 *
 * Handles standard unified diffs, new/deleted files, renames, and binary files.
 */
export function parseUnifiedDiff(diffText: string): DiffFile[] {
  const files: DiffFile[] = [];
  const lines = diffText.split('\n');
  let i = 0;

  while (i < lines.length) {
    if (!lines[i].startsWith('diff --git')) {
      i++;
      continue;
    }

    const file: DiffFile = {
      oldPath: null,
      newPath: null,
      status: 'modified',
      isBinary: false,
      hunks: [],
      additions: 0,
      deletions: 0,
    };

    i++; // skip "diff --git" line

    // Parse file header lines until we hit a hunk or next diff
    while (
      i < lines.length &&
      !lines[i].startsWith('diff --git') &&
      !lines[i].startsWith('@@')
    ) {
      const line = lines[i];

      if (line.startsWith('--- ')) {
        const p = line.slice(4);
        file.oldPath = p === '/dev/null' ? null : p.replace(/^[ab]\//, '');
      } else if (line.startsWith('+++ ')) {
        const p = line.slice(4);
        file.newPath = p === '/dev/null' ? null : p.replace(/^[ab]\//, '');
      } else if (line.startsWith('new file')) {
        file.status = 'added';
      } else if (line.startsWith('deleted file')) {
        file.status = 'deleted';
      } else if (line.startsWith('rename from')) {
        file.status = 'renamed';
        file.oldPath = line.slice('rename from '.length);
      } else if (line.startsWith('rename to')) {
        file.newPath = line.slice('rename to '.length);
      } else if (line.startsWith('Binary files')) {
        file.isBinary = true;
      }

      i++;
    }

    // Parse hunks
    while (i < lines.length && !lines[i].startsWith('diff --git')) {
      if (lines[i].startsWith('@@')) {
        const hunk = parseHunk(lines, i);
        file.hunks.push(hunk.hunk);
        file.additions += hunk.additions;
        file.deletions += hunk.deletions;
        i = hunk.nextIndex;
      } else {
        i++;
      }
    }

    files.push(file);
  }

  return files;
}

/**
 * Generate a human-readable summary from parsed diff files.
 */
export function diffSummary(files: DiffFile[]): string {
  const totalAdded = files.reduce((s, f) => s + f.additions, 0);
  const totalDeleted = files.reduce((s, f) => s + f.deletions, 0);
  const fileList = files
    .map(
      (f) =>
        `  ${f.status === 'added' ? '+' : f.status === 'deleted' ? '-' : '~'} ${f.newPath ?? f.oldPath} (+${f.additions} -${f.deletions})`,
    )
    .join('\n');
  return `${files.length} file(s) changed, ${totalAdded} insertions(+), ${totalDeleted} deletions(-)\n\n${fileList}`;
}

// ── Internals ────────────────────────────────────────────────────────

function parseHunk(
  lines: string[],
  startIndex: number,
): { hunk: DiffHunk; additions: number; deletions: number; nextIndex: number } {
  const headerLine = lines[startIndex];
  const headerMatch = headerLine.match(
    /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@\s*(.*)?$/,
  );

  if (!headerMatch) {
    return {
      hunk: {
        header: headerLine,
        oldStart: 0,
        oldCount: 0,
        newStart: 0,
        newCount: 0,
        lines: [],
      },
      additions: 0,
      deletions: 0,
      nextIndex: startIndex + 1,
    };
  }

  const hunk: DiffHunk = {
    header: headerLine,
    oldStart: parseInt(headerMatch[1], 10),
    oldCount: parseInt(headerMatch[2] ?? '1', 10),
    newStart: parseInt(headerMatch[3], 10),
    newCount: parseInt(headerMatch[4] ?? '1', 10),
    context: headerMatch[5] || undefined,
    lines: [],
  };

  let i = startIndex + 1;
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  let additions = 0;
  let deletions = 0;

  while (
    i < lines.length &&
    !lines[i].startsWith('@@') &&
    !lines[i].startsWith('diff --git')
  ) {
    const line = lines[i];

    if (line.startsWith('+')) {
      hunk.lines.push({
        type: 'add',
        content: line.slice(1),
        oldLineNumber: null,
        newLineNumber: newLine++,
      });
      additions++;
    } else if (line.startsWith('-')) {
      hunk.lines.push({
        type: 'delete',
        content: line.slice(1),
        oldLineNumber: oldLine++,
        newLineNumber: null,
      });
      deletions++;
    } else if (line.startsWith(' ') || line === '') {
      hunk.lines.push({
        type: 'context',
        content: line.startsWith(' ') ? line.slice(1) : line,
        oldLineNumber: oldLine++,
        newLineNumber: newLine++,
      });
    } else if (line.startsWith('\\')) {
      // "\ No newline at end of file" — skip
    } else {
      break; // unknown line format — end of hunk
    }

    i++;
  }

  return { hunk, additions, deletions, nextIndex: i };
}
