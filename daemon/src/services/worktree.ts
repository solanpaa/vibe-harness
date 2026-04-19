// ---------------------------------------------------------------------------
// Worktree Service (CDD §4)
//
// Git worktree lifecycle: create, remove, diff, commit, rebase, merge.
// All git write operations go through a per-repository Mutex.
// ---------------------------------------------------------------------------

import path from 'node:path';
import fs from 'node:fs';
import type { Logger } from 'pino';
import { Mutex } from '../lib/mutex.js';
import { assertSafeRef } from '../lib/validation.js';
import { execCommand } from '../lib/shell.js';
import type { DiffFile } from './diff-parser.js';
import {
  WorktreeCreateError,
  WorktreeNotFoundError,
  BranchAlreadyExistsError,
  GitOperationError,
  MergeError,
  PathTraversalError,
} from '../lib/errors.js';

// ── Constants ────────────────────────────────────────────────────────

const WORKTREE_DIR = '.vibe-harness-worktrees';

// ── Types ────────────────────────────────────────────────────────────

export interface WorktreeCreateResult {
  worktreePath: string;
  branch: string;
}

export interface DiffResult {
  rawDiff: string;
  files: DiffFile[];
  stats: { filesChanged: number; insertions: number; deletions: number };
}

export interface RebaseResult {
  success: boolean;
  conflictFiles?: string[];
}

export interface MergeResult {
  success: boolean;
  conflictFiles?: string[];
}

export interface WorktreeService {
  create(
    projectPath: string,
    branchName: string,
    baseBranch: string,
  ): Promise<WorktreeCreateResult>;

  remove(
    projectPath: string,
    worktreePath: string,
    options?: { deleteBranch?: string },
  ): Promise<void>;

  getDiff(worktreePath: string, baseBranch: string): Promise<DiffResult>;

  commitAll(
    projectPath: string,
    worktreePath: string,
    message: string,
  ): Promise<{ committed: boolean; sha?: string }>;

  rebase(
    projectPath: string,
    worktreePath: string,
    targetBranch: string,
  ): Promise<RebaseResult>;

  mergeBranch(
    projectPath: string,
    worktreePath: string,
    sourceBranch: string,
    targetBranch: string,
    options?: { noFf?: boolean },
  ): Promise<MergeResult>;

  fastForwardMerge(
    projectPath: string,
    branch: string,
    targetBranch: string,
  ): Promise<void>;

  /** Create and checkout a new branch in a worktree. */
  checkoutNewBranch(
    projectPath: string,
    worktreePath: string,
    branchName: string,
  ): Promise<void>;

  /** Check if a branch/commit is an ancestor of HEAD in the given worktree. */
  isAncestor(worktreePath: string, ref: string): Promise<boolean>;

  listBranches(projectPath: string): Promise<string[]>;

  exists(worktreePath: string): Promise<boolean>;

  /** Get the HEAD commit SHA and message from a worktree. */
  getHeadSha(
    projectPath: string,
    worktreePath: string,
  ): Promise<{ sha: string; message: string } | null>;
}

// ── Factory ──────────────────────────────────────────────────────────

export function createWorktreeService(deps: {
  logger: Logger;
  diffParser: { parseUnifiedDiff: (text: string) => DiffFile[] };
}): WorktreeService {
  const { logger, diffParser } = deps;

  /**
   * Per-repository mutex prevents concurrent git write operations
   * from corrupting repository state. (CDD §4.2)
   */
  const repoLocks = new Map<string, Mutex>();

  function getRepoLock(projectPath: string): Mutex {
    const resolved = path.resolve(projectPath);
    let mutex = repoLocks.get(resolved);
    if (!mutex) {
      mutex = new Mutex();
      repoLocks.set(resolved, mutex);
    }
    return mutex;
  }

  async function git(args: string[], cwd: string) {
    return execCommand('git', args, { cwd });
  }

  // Ensure the worktree base dir exists and is git-ignored
  function ensureWorktreeDir(projectPath: string): void {
    const worktreeBase = path.join(projectPath, WORKTREE_DIR);
    if (!fs.existsSync(worktreeBase)) {
      fs.mkdirSync(worktreeBase, { recursive: true });
    }
    const gitignorePath = path.join(projectPath, '.gitignore');
    const gitignoreContent = fs.existsSync(gitignorePath)
      ? fs.readFileSync(gitignorePath, 'utf-8')
      : '';
    if (!gitignoreContent.includes(WORKTREE_DIR)) {
      fs.appendFileSync(
        gitignorePath,
        `\n# Vibe Harness worktrees\n${WORKTREE_DIR}/\n`,
      );
    }
  }

  // ── create ───────────────────────────────────────────────────────

  async function create(
    projectPath: string,
    branchName: string,
    baseBranch: string,
  ): Promise<WorktreeCreateResult> {
    assertSafeRef(branchName, 'branchName');
    assertSafeRef(baseBranch, 'baseBranch');

    const worktreePath = path.join(projectPath, WORKTREE_DIR, branchName);
    const log = logger.child({ projectPath, branchName, baseBranch });

    return getRepoLock(projectPath).runExclusive(async () => {
      log.info('Creating worktree');
      ensureWorktreeDir(projectPath);

      const result = await git(
        ['worktree', 'add', worktreePath, '-b', branchName, baseBranch],
        projectPath,
      );

      if (result.exitCode !== 0) {
        if (result.stderr.includes('already exists')) {
          // Idempotent: if branch exists (e.g. step retry), reuse existing worktree
          log.info({ branchName }, 'Branch already exists, reusing worktree');
          return { worktreePath, branch: branchName };
        }
        throw new WorktreeCreateError(branchName, result.stderr);
      }

      log.info({ worktreePath }, 'Worktree created');
      return { worktreePath, branch: branchName };
    });
  }

  // ── remove ───────────────────────────────────────────────────────

  async function remove(
    projectPath: string,
    worktreePath: string,
    options?: { deleteBranch?: string },
  ): Promise<void> {
    const log = logger.child({ projectPath, worktreePath });

    return getRepoLock(projectPath).runExclusive(async () => {
      const removeResult = await git(
        ['worktree', 'remove', worktreePath, '--force'],
        projectPath,
      );

      if (removeResult.exitCode !== 0) {
        if (!removeResult.stderr.includes('is not a working tree')) {
          log.warn({ stderr: removeResult.stderr }, 'Worktree remove returned error, falling back to rm + prune');
          // Fallback: manual rm + prune — validate path is inside worktree dir
          const allowedBase = path.resolve(path.join(projectPath, WORKTREE_DIR));
          const resolvedWorktree = path.resolve(worktreePath);
          if (!resolvedWorktree.startsWith(allowedBase + path.sep) && resolvedWorktree !== allowedBase) {
            throw new PathTraversalError(
              `Worktree path '${worktreePath}' is not inside '${allowedBase}' — refusing to delete`,
            );
          }
          if (fs.existsSync(worktreePath)) {
            fs.rmSync(worktreePath, { recursive: true, force: true });
          }
        }
      }

      await git(['worktree', 'prune'], projectPath);

      if (options?.deleteBranch) {
        assertSafeRef(options.deleteBranch, 'deleteBranch');
        const branchResult = await git(
          ['branch', '-D', options.deleteBranch],
          projectPath,
        );
        if (branchResult.exitCode !== 0) {
          log.warn(
            { stderr: branchResult.stderr },
            'Branch delete returned error (may already be deleted)',
          );
        }
      }

      log.info('Worktree removed');

      // Clean up empty parent directories inside .vibe-harness-worktrees/
      try {
        const fs = await import('node:fs/promises');
        let dir = path.dirname(path.resolve(worktreePath));
        const worktreeBase = path.resolve(path.join(projectPath, WORKTREE_DIR));
        while (dir.startsWith(worktreeBase) && dir !== worktreeBase) {
          const entries = await fs.readdir(dir);
          if (entries.length === 0) {
            await fs.rmdir(dir);
            dir = path.dirname(dir);
          } else {
            break;
          }
        }
      } catch {
        // Best-effort cleanup
      }
    });
  }

  // ── getDiff (read — no lock) ─────────────────────────────────────
  //
  // Shows ALL agent work: committed changes since merge-base PLUS any
  // uncommitted modifications in the working tree.  Uses `git diff
  // <mergeBase>` (no `..HEAD`) so the working tree is included without
  // mutating the index.  Untracked new files are captured separately
  // via `git ls-files --others` and appended as synthetic diffs.

  async function getDiff(
    worktreePath: string,
    baseBranch: string,
  ): Promise<DiffResult> {
    assertSafeRef(baseBranch, 'baseBranch');

    const mergeBaseResult = await git(
      ['merge-base', baseBranch, 'HEAD'],
      worktreePath,
    );

    if (mergeBaseResult.exitCode !== 0) {
      throw new GitOperationError('merge-base', mergeBaseResult.stderr);
    }

    const mergeBase = mergeBaseResult.stdout.trim();

    // Primary diff: merge-base → working tree (includes committed + uncommitted)
    const diffResult = await git(
      ['diff', mergeBase],
      worktreePath,
    );

    const statResult = await git(
      ['diff', '--stat', mergeBase],
      worktreePath,
    );

    let rawDiff = diffResult.stdout;

    // Capture untracked files (new files the agent created but didn't git-add)
    const untrackedResult = await git(
      ['ls-files', '--others', '--exclude-standard'],
      worktreePath,
    );

    if (untrackedResult.exitCode === 0 && untrackedResult.stdout.trim()) {
      const untrackedFiles = untrackedResult.stdout.trim().split('\n').filter(Boolean);

      for (const file of untrackedFiles) {
        // Generate a synthetic diff for each untracked file
        const fileDiff = await git(
          ['diff', '--no-index', '/dev/null', file],
          worktreePath,
        );
        // git diff --no-index exits 1 when files differ (expected)
        if (fileDiff.stdout.trim()) {
          rawDiff += '\n' + fileDiff.stdout;
        }
      }
    }

    const files = diffParser.parseUnifiedDiff(rawDiff);
    const stats = parseDiffStats(statResult.stdout);

    // Adjust stats to account for untracked files
    if (untrackedResult.exitCode === 0 && untrackedResult.stdout.trim()) {
      const untrackedCount = untrackedResult.stdout.trim().split('\n').filter(Boolean).length;
      if (untrackedCount > 0) {
        // Re-count from parsed files for accuracy
        let totalInsertions = 0;
        let totalDeletions = 0;
        for (const f of files) {
          totalInsertions += f.additions;
          totalDeletions += f.deletions;
        }
        stats.filesChanged = files.length;
        stats.insertions = totalInsertions;
        stats.deletions = totalDeletions;
      }
    }

    return { rawDiff, files, stats };
  }

  // ── commitAll ────────────────────────────────────────────────────

  async function commitAll(
    projectPath: string,
    worktreePath: string,
    message: string,
  ): Promise<{ committed: boolean; sha?: string }> {
    return getRepoLock(projectPath).runExclusive(async () => {
      await git(['add', '-A'], worktreePath);

      const status = await git(['status', '--porcelain'], worktreePath);
      if (!status.stdout.trim()) {
        return { committed: false };
      }

      const commitResult = await git(
        ['commit', '-m', message],
        worktreePath,
      );

      if (commitResult.exitCode !== 0) {
        throw new GitOperationError('commit', commitResult.stderr);
      }

      const shaResult = await git(['rev-parse', 'HEAD'], worktreePath);
      return { committed: true, sha: shaResult.stdout.trim() };
    });
  }

  // ── rebase ───────────────────────────────────────────────────────

  async function rebase(
    projectPath: string,
    worktreePath: string,
    targetBranch: string,
  ): Promise<RebaseResult> {
    assertSafeRef(targetBranch, 'targetBranch');

    return getRepoLock(projectPath).runExclusive(async () => {
      // Check if already rebased
      const ancestorCheck = await git(
        ['merge-base', '--is-ancestor', targetBranch, 'HEAD'],
        worktreePath,
      );

      if (ancestorCheck.exitCode === 0) {
        return { success: true };
      }

      const result = await git(['rebase', targetBranch], worktreePath);

      if (result.exitCode !== 0) {
        if (
          result.stderr.includes('CONFLICT') ||
          result.stderr.includes('could not apply')
        ) {
          const conflictResult = await git(
            ['diff', '--name-only', '--diff-filter=U'],
            worktreePath,
          );
          const conflictFiles = conflictResult.stdout
            .trim()
            .split('\n')
            .filter(Boolean);

          await git(['rebase', '--abort'], worktreePath);

          return { success: false, conflictFiles };
        }

        throw new GitOperationError('rebase', result.stderr);
      }

      return { success: true };
    });
  }

  // ── mergeBranch ──────────────────────────────────────────────────

  async function mergeBranch(
    projectPath: string,
    worktreePath: string,
    sourceBranch: string,
    targetBranch: string,
    options?: { noFf?: boolean },
  ): Promise<MergeResult> {
    assertSafeRef(sourceBranch, 'sourceBranch');
    assertSafeRef(targetBranch, 'targetBranch');

    return getRepoLock(projectPath).runExclusive(async () => {
      // Checkout target branch in the worktree
      const checkoutResult = await git(['checkout', targetBranch], worktreePath);
      if (checkoutResult.exitCode !== 0) {
        throw new GitOperationError('checkout', checkoutResult.stderr);
      }

      const mergeArgs = ['merge', sourceBranch];
      if (options?.noFf) {
        mergeArgs.splice(1, 0, '--no-ff');
      }

      const mergeResult = await git(mergeArgs, worktreePath);

      if (mergeResult.exitCode !== 0) {
        if (
          mergeResult.stderr.includes('CONFLICT') ||
          mergeResult.stdout.includes('CONFLICT') ||
          mergeResult.stderr.includes('Automatic merge failed')
        ) {
          const conflictResult = await git(
            ['diff', '--name-only', '--diff-filter=U'],
            worktreePath,
          );
          const conflictFiles = conflictResult.stdout
            .trim()
            .split('\n')
            .filter(Boolean);

          await git(['merge', '--abort'], worktreePath);

          return { success: false, conflictFiles };
        }

        throw new GitOperationError('merge', mergeResult.stderr);
      }

      return { success: true };
    });
  }

  // ── fastForwardMerge ─────────────────────────────────────────────

  async function fastForwardMerge(
    projectPath: string,
    branch: string,
    targetBranch: string,
  ): Promise<void> {
    assertSafeRef(branch, 'branch');
    assertSafeRef(targetBranch, 'targetBranch');

    return getRepoLock(projectPath).runExclusive(async () => {
      // Remember current branch to restore later
      const currentBranchResult = await git(
        ['rev-parse', '--abbrev-ref', 'HEAD'],
        projectPath,
      );
      const currentBranch = currentBranchResult.stdout.trim();

      try {
        const checkoutResult = await git(
          ['checkout', targetBranch],
          projectPath,
        );
        if (checkoutResult.exitCode !== 0) {
          throw new GitOperationError('checkout', checkoutResult.stderr);
        }

        const mergeResult = await git(
          ['merge', '--ff-only', branch],
          projectPath,
        );
        if (mergeResult.exitCode !== 0) {
          throw new MergeError(branch, targetBranch, mergeResult.stderr);
        }
      } finally {
        // Restore original branch (best-effort)
        await git(['checkout', currentBranch], projectPath);
      }
    });
  }

  // ── listBranches (read — no lock) ────────────────────────────────

  async function listBranches(projectPath: string): Promise<string[]> {
    const result = await git(
      ['branch', '--list', '--format=%(refname:short)'],
      projectPath,
    );
    return result.stdout.trim().split('\n').filter(Boolean);
  }

  // ── exists (read — no lock) ──────────────────────────────────────

  async function exists(worktreePath: string): Promise<boolean> {
    try {
      const result = await git(
        ['rev-parse', '--is-inside-work-tree'],
        worktreePath,
      );
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  // ── checkoutNewBranch ───────────────────────────────────────────

  async function checkoutNewBranch(
    projectPath: string,
    worktreePath: string,
    branchName: string,
  ): Promise<void> {
    assertSafeRef(branchName, 'branchName');

    return getRepoLock(projectPath).runExclusive(async () => {
      const result = await git(['checkout', '-b', branchName], worktreePath);
      if (result.exitCode !== 0) {
        throw new GitOperationError('checkout -b', result.stderr);
      }
    });
  }

  // ── isAncestor (read — no lock) ────────────────────────────────

  async function isAncestor(
    worktreePath: string,
    ref: string,
  ): Promise<boolean> {
    assertSafeRef(ref, 'ref');
    const result = await git(['merge-base', '--is-ancestor', ref, 'HEAD'], worktreePath);
    return result.exitCode === 0;
  }

  async function getHeadSha(
    _projectPath: string,
    worktreePath: string,
  ): Promise<{ sha: string; message: string } | null> {
    const result = await git(['log', '-1', '--format=%H%n%s'], worktreePath);
    if (result.exitCode !== 0) return null;
    const lines = result.stdout.trim().split('\n');
    if (lines.length < 2) return null;
    return { sha: lines[0], message: lines[1] };
  }

  return {
    create,
    remove,
    getDiff,
    commitAll,
    rebase,
    mergeBranch,
    fastForwardMerge,
    checkoutNewBranch,
    isAncestor,
    listBranches,
    exists,
    getHeadSha,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────

/** Parse `git diff --stat` summary line into structured stats. */
function parseDiffStats(statOutput: string): {
  filesChanged: number;
  insertions: number;
  deletions: number;
} {
  const summary = statOutput.trim().split('\n').pop() ?? '';
  const filesMatch = summary.match(/(\d+) files? changed/);
  const insertMatch = summary.match(/(\d+) insertions?\(\+\)/);
  const deleteMatch = summary.match(/(\d+) deletions?\(-\)/);

  return {
    filesChanged: filesMatch ? parseInt(filesMatch[1], 10) : 0,
    insertions: insertMatch ? parseInt(insertMatch[1], 10) : 0,
    deletions: deleteMatch ? parseInt(deleteMatch[1], 10) : 0,
  };
}
