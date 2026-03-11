import { execSync } from "child_process";
import path from "path";
import fs from "fs";

const WORKTREE_DIR = ".vibe-harness-worktrees";

/**
 * Create a git worktree for a session.
 * Returns the worktree path. If the project isn't a git repo,
 * returns the project dir as-is (no isolation).
 */
export function createWorktree(
  projectDir: string,
  sessionId: string,
  branchName?: string
): { worktreePath: string; branch: string; isWorktree: boolean } {
  // Check if it's a git repo
  try {
    execSync("git rev-parse --is-inside-work-tree", {
      cwd: projectDir,
      stdio: "pipe",
    });
  } catch {
    return { worktreePath: projectDir, branch: "", isWorktree: false };
  }

  const shortId = sessionId.slice(0, 8);
  const branch = branchName || `vibe-harness/session-${shortId}`;
  const worktreeBase = path.join(projectDir, WORKTREE_DIR);
  const worktreePath = path.join(worktreeBase, shortId);

  // Ensure the worktree base directory exists
  if (!fs.existsSync(worktreeBase)) {
    fs.mkdirSync(worktreeBase, { recursive: true });
    // Add to .gitignore if not already there
    const gitignorePath = path.join(projectDir, ".gitignore");
    const gitignoreContent = fs.existsSync(gitignorePath)
      ? fs.readFileSync(gitignorePath, "utf-8")
      : "";
    if (!gitignoreContent.includes(WORKTREE_DIR)) {
      fs.appendFileSync(gitignorePath, `\n# Vibe Harness worktrees\n${WORKTREE_DIR}/\n`);
    }
  }

  // Create the worktree with a new branch from HEAD
  try {
    execSync(`git worktree add -b "${branch}" "${worktreePath}" HEAD`, {
      cwd: projectDir,
      stdio: "pipe",
    });
  } catch (e) {
    // Branch might already exist — try without -b
    try {
      execSync(`git worktree add "${worktreePath}" "${branch}"`, {
        cwd: projectDir,
        stdio: "pipe",
      });
    } catch {
      // Worktree might already exist
      if (fs.existsSync(worktreePath)) {
        return { worktreePath, branch, isWorktree: true };
      }
      throw e;
    }
  }

  return { worktreePath, branch, isWorktree: true };
}

/**
 * Remove a git worktree after a session is done.
 */
export function removeWorktree(projectDir: string, sessionId: string): void {
  const shortId = sessionId.slice(0, 8);
  const worktreePath = path.join(projectDir, WORKTREE_DIR, shortId);

  if (!fs.existsSync(worktreePath)) return;

  try {
    execSync(`git worktree remove "${worktreePath}" --force`, {
      cwd: projectDir,
      stdio: "pipe",
    });
  } catch {
    // Fallback: just delete the directory
    fs.rmSync(worktreePath, { recursive: true, force: true });
    try {
      execSync("git worktree prune", { cwd: projectDir, stdio: "pipe" });
    } catch {
      // ignore
    }
  }
}

/**
 * Get the diff between a worktree and the main branch.
 */
export function getWorktreeDiff(
  projectDir: string,
  worktreePath: string
): string {
  try {
    // Get the merge base (where the worktree branched from)
    const mergeBase = execSync("git merge-base HEAD main", {
      cwd: worktreePath,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    return execSync(`git diff ${mergeBase} HEAD`, {
      cwd: worktreePath,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch {
    // Fallback: diff against HEAD (unstaged + staged)
    try {
      return execSync("git diff HEAD", {
        cwd: worktreePath,
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch {
      return "";
    }
  }
}
