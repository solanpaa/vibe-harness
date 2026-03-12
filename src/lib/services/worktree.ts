import { execSync } from "child_process";
import path from "path";
import fs from "fs";

const WORKTREE_DIR = ".vibe-harness-worktrees";

/**
 * Create a git worktree for a task.
 * Returns the worktree path. If the project isn't a git repo,
 * returns the project dir as-is (no isolation).
 */
export function createWorktree(
  projectDir: string,
  taskId: string,
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

  const shortId = taskId.slice(0, 8);
  const branch = branchName || `vibe-harness/task-${shortId}`;
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
 * Remove a git worktree after a task is done.
 */
export function removeWorktree(projectDir: string, taskId: string): void {
  const shortId = taskId.slice(0, 8);
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
 * Commit all changes in a worktree and merge the branch back into
 * whichever branch the main working tree is currently on (i.e. the
 * branch the worktree was forked from).
 */
export function commitAndMergeWorktree(
  projectDir: string,
  taskId: string,
  commitMessage: string
): { merged: boolean; branch: string; error?: string } {
  const shortId = taskId.slice(0, 8);
  const worktreePath = path.join(projectDir, WORKTREE_DIR, shortId);

  if (!fs.existsSync(worktreePath)) {
    return { merged: false, branch: "", error: "Worktree not found" };
  }

  const branch = `vibe-harness/task-${shortId}`;

  try {
    // Stage and commit all changes in the worktree
    execSync("git add -A", { cwd: worktreePath, stdio: "pipe" });

    // Check if there's anything to commit
    try {
      execSync("git diff --cached --quiet", { cwd: worktreePath, stdio: "pipe" });
      // No changes staged — nothing to commit, but branch may already have commits
    } catch {
      // There are staged changes — commit them
      execSync(`git commit -m "${commitMessage.replace(/"/g, '\\"')}"`, {
        cwd: worktreePath,
        stdio: "pipe",
      });
    }

    // Merge into whatever branch the main working tree is on
    execSync(`git merge "${branch}" --no-ff -m "Merge approved task ${shortId}"`, {
      cwd: projectDir,
      stdio: "pipe",
    });

    return { merged: true, branch };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { merged: false, branch, error: msg };
  }
}

/**
 * Fast-forward merge a task branch into the main working tree's current branch.
 * Use after the AI has committed and rebased the task branch.
 */
export function fastForwardMerge(
  projectDir: string,
  taskId: string
): { merged: boolean; branch: string; error?: string } {
  const shortId = taskId.slice(0, 8);
  const branch = `vibe-harness/task-${shortId}`;

  try {
    execSync(`git merge "${branch}" --ff-only`, {
      cwd: projectDir,
      stdio: "pipe",
    });
    return { merged: true, branch };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { merged: false, branch, error: msg };
  }
}

/**
 * Rebase the worktree branch onto the target branch.
 * Returns success or error (e.g. conflicts). Aborts rebase on failure.
 */
export function rebaseWorktree(
  projectDir: string,
  taskId: string,
  targetBranch: string
): { rebased: boolean; error?: string } {
  const shortId = taskId.slice(0, 8);
  const worktreePath = path.join(projectDir, WORKTREE_DIR, shortId);

  if (!fs.existsSync(worktreePath)) {
    return { rebased: false, error: "Worktree not found" };
  }

  try {
    execSync(`git rebase "${targetBranch}"`, {
      cwd: worktreePath,
      stdio: "pipe",
    });
    return { rebased: true };
  } catch (e) {
    // Abort the failed rebase so the branch is left clean
    try {
      execSync("git rebase --abort", { cwd: worktreePath, stdio: "pipe" });
    } catch {
      // May fail if rebase wasn't in progress
    }
    const msg = e instanceof Error ? e.message : String(e);
    return { rebased: false, error: msg };
  }
}

/**
 * Stage and commit all changes in a worktree.
 * Returns true if a commit was made, false if there was nothing to commit.
 */
export function commitWorktreeChanges(
  projectDir: string,
  taskId: string,
  commitMessage: string
): { committed: boolean; error?: string } {
  const shortId = taskId.slice(0, 8);
  const worktreePath = path.join(projectDir, WORKTREE_DIR, shortId);

  if (!fs.existsSync(worktreePath)) {
    return { committed: false, error: "Worktree not found" };
  }

  try {
    execSync("git add -A", { cwd: worktreePath, stdio: "pipe" });

    try {
      execSync("git diff --cached --quiet", { cwd: worktreePath, stdio: "pipe" });
      // No staged changes
      return { committed: false };
    } catch {
      // Has staged changes — commit them
      execSync(`git commit -m "${commitMessage.replace(/"/g, '\\"')}"`, {
        cwd: worktreePath,
        stdio: "pipe",
      });
      return { committed: true };
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { committed: false, error: msg };
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
