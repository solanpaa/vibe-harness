# Vibe Harness v2 — Component Detailed Design: Services Layer

> **Scope:** All services under `daemon/src/services/`. This document contains implementable TypeScript interfaces, function signatures, error types, and key implementation patterns.
>
> **References:** SAD §5.1 (Service DAG), §5.5 (Git Operations), §6 (Security), §10 (Cross-cutting). SRD §2.3–2.7 (Functional Requirements).

---

## Table of Contents

1. [Service Dependency DAG](#1-service-dependency-dag)
2. [Shared Types & Utilities](#2-shared-types--utilities)
3. [Sandbox Service](#3-sandbox-service)
4. [Worktree Service](#4-worktree-service)
5. [ACP Client](#5-acp-client)
6. [Streaming Service](#6-streaming-service)
7. [Review Service](#7-review-service)
8. [Credential Vault](#8-credential-vault)
9. [Branch Namer](#9-branch-namer)
10. [Diff Parser](#10-diff-parser)
11. [Error Types](#11-error-types)
12. [Initialization & Dependency Injection](#12-initialization--dependency-injection)

---

## 1. Service Dependency DAG

From SAD §5.1 — services form a strict DAG with no circular dependencies:

```
                    ┌──────────────────┐
                    │  session-manager  │  (workflow layer — NOT in this CDD)
                    └───┬───┬───┬───┬──┘
                        │   │   │   │
           ┌────────────┘   │   │   └────────────┐
           ▼                ▼   ▼                ▼
    ┌──────────┐   ┌──────────┐ ┌──────────┐  ┌─────────────────┐
    │ sandbox  │   │ worktree │ │acp-client│  │credential-vault │
    └──────────┘   └──────────┘ └─────┬────┘  └─────────────────┘
                                      │
                               ┌──────▼────────────┐
                               │ streaming-service  │
                               └───────────────────┘

    ┌────────────────┐         ┌──────────┐
    │ review-service │────────►│ worktree │
    │                │────────►│branch-namer│
    └────────────────┘         └──────────┘

    ┌──────────┐   ┌──────────────┐   ┌─────────────────┐
    │diff-parser│   │ branch-namer │   │credential-vault │
    │(standalone)│   │ (standalone) │   │  (standalone)   │
    └──────────┘   └──────────────┘   └─────────────────┘
```

**Initialization order** (reverse topological sort of dependencies):

1. `diff-parser` — pure, no dependencies
2. `branch-namer` — standalone, calls LLM
3. `credential-vault` — standalone, reads DB + encryption
4. `sandbox` — standalone, shells out to Docker
5. `worktree` — standalone, shells out to git
6. `acp-client` — standalone, manages stdio streams
7. `streaming-service` — depends on acp-client event types
8. `review-service` — depends on worktree, branch-namer, diff-parser

Services above this line are instantiated by the daemon startup sequence and injected into workflow steps. The `session-manager` (workflow layer) is documented in a separate CDD.

---

## 2. Shared Types & Utilities

These types are used across multiple services and live in `shared/types/` or `daemon/src/lib/`.

### 2.1 Validation Utilities (SAD §10.1)

```typescript
// lib/validation.ts

/** Allowed characters in git refs: alphanumeric, dot, underscore, hyphen, slash */
const SAFE_REF_PATTERN = /^[a-zA-Z0-9._/-]+$/;

/** Characters explicitly blocked in any shell-adjacent input */
const BLOCKED_CHARS = /[`$;|<>(){}\\\n]/;

/** Double-dot traversal blocked in git refs */
const DOUBLE_DOT = /\.\./;

/**
 * Validates a git ref (branch name, tag) is safe for shell use.
 * Throws InvalidGitRefError if the ref contains dangerous characters.
 *
 * Called at the SERVICE layer (not route layer) so all callers
 * — routes, workflow steps — are protected. (SAD §10.1)
 */
export function assertSafeRef(ref: string, label = 'ref'): void {
  if (!ref || ref.trim().length === 0) {
    throw new InvalidGitRefError(`${label} must not be empty`);
  }
  if (DOUBLE_DOT.test(ref)) {
    throw new InvalidGitRefError(`${label} must not contain '..'`);
  }
  if (BLOCKED_CHARS.test(ref)) {
    throw new InvalidGitRefError(
      `${label} contains disallowed characters: ${ref}`
    );
  }
  if (!SAFE_REF_PATTERN.test(ref)) {
    throw new InvalidGitRefError(
      `${label} contains invalid characters (allowed: a-z A-Z 0-9 . _ / -): ${ref}`
    );
  }
}

/**
 * Validates a file path is within the expected base directory.
 * Prevents path traversal attacks.
 */
export function assertSafePath(filePath: string, basePath: string): void {
  const resolved = path.resolve(basePath, filePath);
  if (!resolved.startsWith(path.resolve(basePath))) {
    throw new PathTraversalError(
      `Path ${filePath} escapes base directory ${basePath}`
    );
  }
}
```

### 2.2 Shell Execution Helper

```typescript
// lib/shell.ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Execute a command with explicit argument array (no shell interpolation).
 * All services use this instead of exec() to prevent injection.
 *
 * @param command - Executable name (e.g., 'git', 'docker')
 * @param args - Argument array (never concatenated into a string)
 * @param options - cwd, env overrides, timeout
 */
export async function execCommand(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: Record<string, string>;
    timeout?: number;
    stdin?: string;
  } = {}
): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      timeout: options.timeout ?? 60_000,
      maxBuffer: 50 * 1024 * 1024, // 50MB for large diffs
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (err: any) {
    if (err.killed) {
      throw new CommandTimeoutError(command, args, options.timeout ?? 60_000);
    }
    return {
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
      exitCode: err.code ?? 1,
    };
  }
}
```

### 2.3 Mutex

```typescript
// lib/mutex.ts

/**
 * Simple async mutex for serializing access to shared resources.
 * Used by WorktreeService (per-repo lock, SAD §5.5.1) and
 * SessionManager (per-run ACP stdin lock, SAD §5.4).
 */
export class Mutex {
  private queue: Array<() => void> = [];
  private locked = false;

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (!this.locked) {
        this.locked = true;
        resolve();
      } else {
        this.queue.push(resolve);
      }
    });
  }

  private release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      next();
    } else {
      this.locked = false;
    }
  }
}
```

---

## 3. Sandbox Service

**File:** `services/sandbox.ts`
**Responsibility:** Docker sandbox lifecycle — create, exec, stop, list. One sandbox per workflow run. (SAD §6.2, SRD §2.4 FR-W17)

### 3.1 Interface

```typescript
// services/sandbox.ts

export interface SandboxCreateOptions {
  /** Workflow run ID — used to derive sandbox name: vibe-<first8chars> */
  runId: string;
  /** Docker image to use (from agent definition) */
  image: string;
  /** Host path to mount as the working directory (worktree path) */
  workdir: string;
  /** Network policy for this project (SAD §6.2) */
  networkPolicy: NetworkPolicy;
  /** Network allowlist hosts (only used when networkPolicy is 'allowlist') */
  networkAllowlist?: string[];
  /** Credential injection args built by CredentialVault.buildSandboxCredentials() */
  credentials?: SandboxCredentials;
}

export type NetworkPolicy = 'open' | 'localhost_only' | 'allowlist';

export interface SandboxCredentials {
  /** -e KEY=VALUE pairs for env_var and command_extract types */
  envVars: Array<{ key: string; value: string }>;
  /** File contents to pipe into sandbox via stdin */
  fileMounts: Array<{ mountPath: string; content: string }>;
  /** Docker registry login commands to run inside sandbox */
  dockerLogins: Array<{ registry: string; username: string; password: string }>;
  /** Read-only host directory bind mounts */
  hostDirMounts: Array<{ hostPath: string; containerPath: string }>;
}

export interface SandboxExecOptions {
  /** Command and arguments to run inside the sandbox */
  command: string[];
  /** Environment variables to set for this exec invocation */
  env?: Record<string, string>;
  /** If true, spawn with stdin/stdout piped (for ACP) */
  interactive?: boolean;
  /** Working directory inside the sandbox */
  workdir?: string;
}

export interface SandboxProcess {
  /** Node.js ChildProcess for stdio access */
  process: import('node:child_process').ChildProcess;
  /** Sandbox name for subsequent operations */
  sandboxName: string;
}

export interface SandboxInfo {
  name: string;
  status: 'running' | 'stopped' | 'unknown';
  image: string;
  created: string;
}

export interface SandboxService {
  /**
   * Create and start a Docker sandbox for a workflow run.
   *
   * Steps:
   *   1. Derive sandbox name: vibe-<runId.slice(0,8)>
   *   2. docker sandbox create --image <image> --name <name>
   *   3. docker sandbox network proxy (configure based on networkPolicy)
   *   4. Mount workdir and any host directory mounts
   *   5. Inject credentials (env vars, file mounts, docker logins)
   *   6. Register in activeSandboxes map
   *
   * @throws SandboxProvisionError if Docker command fails
   * @throws SandboxAlreadyExistsError if sandbox name is taken
   */
  create(options: SandboxCreateOptions): Promise<string>;

  /**
   * Execute a command inside a running sandbox.
   *
   * For ACP sessions (interactive=true), returns a SandboxProcess
   * with piped stdin/stdout for NDJSON communication.
   *
   * For non-interactive commands (credential injection, file operations),
   * waits for completion and returns stdout/stderr.
   *
   * @throws SandboxNotFoundError if sandbox doesn't exist
   * @throws SandboxExecError if command exits non-zero (non-interactive only)
   */
  exec(
    sandboxName: string,
    options: SandboxExecOptions
  ): Promise<SandboxProcess | ExecResult>;

  /**
   * Stop a sandbox — graceful stop then force kill.
   *
   * Steps:
   *   1. docker sandbox stop <name> (SIGTERM)
   *   2. Wait up to forceKillTimeout (default 10s)
   *   3. docker sandbox rm --force <name> if still running
   *   4. Remove from activeSandboxes map
   *
   * Safe to call multiple times (idempotent).
   */
  stop(sandboxName: string, forceKillTimeout?: number): Promise<void>;

  /**
   * List all vibe-* sandboxes for startup reconciliation (SAD §2.1.3).
   *
   * Runs: docker sandbox ls --filter name=vibe-* --format json
   */
  list(): Promise<SandboxInfo[]>;

  /**
   * Check if a sandbox is currently tracked as active.
   */
  isActive(sandboxName: string): boolean;

  /**
   * Derive the sandbox name from a workflow run ID.
   */
  getSandboxName(runId: string): string;
}
```

### 3.2 Implementation Notes

```typescript
// services/sandbox.ts — implementation sketch

import { Mutex } from '../lib/mutex.js';
import { execCommand, type ExecResult } from '../lib/shell.js';
import { spawn } from 'node:child_process';
import type { Logger } from 'pino';

export function createSandboxService(deps: {
  logger: Logger;
}): SandboxService {
  const { logger } = deps;

  /**
   * In-memory map of active sandboxes. Survives hot-reload via globalThis
   * in dev, but NOT daemon restart — reconciliation rebuilds from Docker.
   */
  const activeSandboxes = new Map<string, { runId: string; pid?: number }>();

  function getSandboxName(runId: string): string {
    return `vibe-${runId.slice(0, 8)}`;
  }

  async function create(options: SandboxCreateOptions): Promise<string> {
    const sandboxName = getSandboxName(options.runId);
    const log = logger.child({ sandboxName, runId: options.runId });

    if (activeSandboxes.has(sandboxName)) {
      throw new SandboxAlreadyExistsError(sandboxName);
    }

    // Step 1: Create sandbox
    log.info('Creating Docker sandbox');
    const createResult = await execCommand('docker', [
      'sandbox', 'create',
      '--name', sandboxName,
      '--image', options.image,
      // Host dir mounts are passed as create-time arguments
      ...buildHostDirMountArgs(options.credentials?.hostDirMounts ?? []),
    ]);

    if (createResult.exitCode !== 0) {
      throw new SandboxProvisionError(
        sandboxName,
        `docker sandbox create failed: ${createResult.stderr}`
      );
    }

    // Step 2: Configure network proxy (SAD §6.2)
    await configureNetworkProxy(sandboxName, options.networkPolicy, options.networkAllowlist);

    // Step 3: Inject credentials (must happen before ACP session starts)
    if (options.credentials) {
      await injectCredentials(sandboxName, options.credentials, log);
    }

    activeSandboxes.set(sandboxName, { runId: options.runId });
    log.info('Sandbox created successfully');
    return sandboxName;
  }

  async function exec(
    sandboxName: string,
    options: SandboxExecOptions
  ): Promise<SandboxProcess | ExecResult> {
    if (!activeSandboxes.has(sandboxName)) {
      // Allow exec on sandboxes found during reconciliation
      const sandboxes = await list();
      if (!sandboxes.find((s) => s.name === sandboxName)) {
        throw new SandboxNotFoundError(sandboxName);
      }
    }

    if (options.interactive) {
      // Spawn with piped stdin/stdout for ACP communication
      const envArgs = Object.entries(options.env ?? {}).flatMap(
        ([k, v]) => ['-e', `${k}=${v}`]
      );

      const child = spawn('docker', [
        'sandbox', 'exec',
        '-i',
        ...envArgs,
        sandboxName,
        ...options.command,
      ], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      return { process: child, sandboxName };
    }

    // Non-interactive: run and wait
    const envArgs = Object.entries(options.env ?? {}).flatMap(
      ([k, v]) => ['-e', `${k}=${v}`]
    );

    return execCommand('docker', [
      'sandbox', 'exec',
      ...envArgs,
      sandboxName,
      ...options.command,
    ]);
  }

  async function stop(
    sandboxName: string,
    forceKillTimeout = 10_000
  ): Promise<void> {
    const log = logger.child({ sandboxName });

    log.info('Stopping sandbox');
    const stopResult = await execCommand('docker', [
      'sandbox', 'stop', sandboxName,
    ], { timeout: forceKillTimeout });

    if (stopResult.exitCode !== 0) {
      log.warn({ stderr: stopResult.stderr }, 'Graceful stop failed, force removing');
      await execCommand('docker', [
        'sandbox', 'rm', '--force', sandboxName,
      ]);
    }

    activeSandboxes.delete(sandboxName);
    log.info('Sandbox stopped');
  }

  async function listSandboxes(): Promise<SandboxInfo[]> {
    const result = await execCommand('docker', [
      'sandbox', 'ls',
      '--filter', 'name=vibe-',
      '--format', 'json',
    ]);

    if (result.exitCode !== 0 || !result.stdout.trim()) {
      return [];
    }

    // docker sandbox ls --format json outputs one JSON object per line
    return result.stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as SandboxInfo);
  }

  return {
    create,
    exec,
    stop,
    list: listSandboxes,
    isActive: (name) => activeSandboxes.has(name),
    getSandboxName,
  };
}

// --- Internal helpers ---

function buildHostDirMountArgs(
  mounts: Array<{ hostPath: string; containerPath: string }>
): string[] {
  // Read-only bind mounts: -v hostPath:containerPath:ro
  return mounts.flatMap((m) => ['-v', `${m.hostPath}:${m.containerPath}:ro`]);
}

async function configureNetworkProxy(
  sandboxName: string,
  policy: NetworkPolicy,
  allowlist?: string[]
): Promise<void> {
  const args = ['sandbox', 'network', 'proxy', sandboxName];

  switch (policy) {
    case 'open':
      args.push('--allow-host', '*');
      break;
    case 'localhost_only':
      args.push('--allow-host', 'localhost');
      break;
    case 'allowlist':
      for (const host of allowlist ?? []) {
        args.push('--allow-host', host);
      }
      break;
  }

  const result = await execCommand('docker', args);
  if (result.exitCode !== 0) {
    throw new SandboxProvisionError(
      sandboxName,
      `Network proxy setup failed: ${result.stderr}`
    );
  }
}

/**
 * Inject credentials into a running sandbox. (SAD §6.2, SRD FR-C4)
 *
 * Order matters:
 *   1. File mounts (may be needed by docker logins or commands)
 *   2. Docker logins (use mounted config files)
 *   3. Env vars are injected at exec time, not here
 */
async function injectCredentials(
  sandboxName: string,
  creds: SandboxCredentials,
  log: Logger
): Promise<void> {
  // File mounts: pipe content to tee inside sandbox
  for (const mount of creds.fileMounts) {
    log.debug({ mountPath: mount.mountPath }, 'Injecting file mount');

    // Ensure parent directory exists
    await execCommand('docker', [
      'sandbox', 'exec', sandboxName,
      'mkdir', '-p', mount.mountPath.split('/').slice(0, -1).join('/'),
    ]);

    // Pipe content via stdin → tee
    const child = spawn('docker', [
      'sandbox', 'exec', '-i', sandboxName,
      'tee', mount.mountPath,
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    await new Promise<void>((resolve, reject) => {
      child.on('close', (code) =>
        code === 0 ? resolve() : reject(new Error(`tee exited with ${code}`))
      );
      child.on('error', reject);
      child.stdin.end(mount.content);
    });
  }

  // Docker logins: docker login --password-stdin inside sandbox
  for (const login of creds.dockerLogins) {
    log.debug({ registry: login.registry }, 'Injecting Docker login');
    const child = spawn('docker', [
      'sandbox', 'exec', '-i', sandboxName,
      'docker', 'login', login.registry,
      '--username', login.username,
      '--password-stdin',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    await new Promise<void>((resolve, reject) => {
      child.on('close', (code) =>
        code === 0 ? resolve() : reject(new Error(`docker login exited with ${code}`))
      );
      child.on('error', reject);
      child.stdin.end(login.password);
    });
  }
}
```

---

## 4. Worktree Service

**File:** `services/worktree.ts`
**Responsibility:** Git worktree lifecycle — create, remove, diff, commit, rebase, merge. Per-repository mutex for write operations. (SAD §5.5, SRD FR-W18, FR-R10)

### 4.1 Interface

```typescript
// services/worktree.ts

export interface WorktreeCreateResult {
  /** Absolute path to the created worktree */
  worktreePath: string;
  /** Branch name that was created */
  branch: string;
}

export interface DiffResult {
  /** Raw unified diff text */
  rawDiff: string;
  /** Parsed diff files (via DiffParser) */
  files: DiffFile[];
  /** Stats: files changed, insertions, deletions */
  stats: { filesChanged: number; insertions: number; deletions: number };
}

export interface RebaseResult {
  success: boolean;
  /** If rebase failed due to conflicts, lists conflicted file paths */
  conflictFiles?: string[];
}

export interface WorktreeService {
  /**
   * Create a git worktree with a new branch.
   *
   * Steps:
   *   1. assertSafeRef(branchName) — validates branch name (SAD §10.1)
   *   2. assertSafeRef(baseBranch)
   *   3. Acquire repo lock (SAD §5.5.1)
   *   4. git worktree add <project>/.vibe-harness-worktrees/<branchName>/
   *        -b <branchName> <baseBranch>
   *   5. Return worktree path + branch
   *
   * @param projectPath - Absolute path to the project repository root
   * @param branchName - Branch name to create (already sanitized by BranchNamer)
   * @param baseBranch - Branch to base the worktree on
   * @throws InvalidGitRefError if branch name fails validation
   * @throws WorktreeCreateError if git worktree add fails
   * @throws BranchAlreadyExistsError if branch already exists
   */
  create(
    projectPath: string,
    branchName: string,
    baseBranch: string
  ): Promise<WorktreeCreateResult>;

  /**
   * Remove a git worktree and optionally delete the branch.
   *
   * Steps:
   *   1. Acquire repo lock
   *   2. git worktree remove <worktreePath> --force
   *   3. git worktree prune
   *   4. If deleteBranch: git branch -D <branchName>
   *
   * Idempotent: no-op if worktree doesn't exist.
   */
  remove(
    projectPath: string,
    worktreePath: string,
    options?: { deleteBranch?: string }
  ): Promise<void>;

  /**
   * Get the diff between the worktree HEAD and its merge-base with baseBranch.
   *
   * This is a READ operation — does NOT acquire the repo lock.
   *
   * Steps:
   *   1. git merge-base <baseBranch> HEAD (in worktree)
   *   2. git diff <merge-base>..HEAD (in worktree)
   *   3. Parse unified diff → DiffFile[]
   *
   * @param worktreePath - Absolute path to the worktree
   * @param baseBranch - Branch to compute merge-base against
   */
  getDiff(worktreePath: string, baseBranch: string): Promise<DiffResult>;

  /**
   * Stage all changes and create a commit.
   *
   * Steps:
   *   1. Acquire repo lock
   *   2. git add -A (in worktree)
   *   3. git status --porcelain — if empty, return (nothing to commit)
   *   4. git commit -m <message>
   *
   * Idempotent: no-op if working tree is clean.
   */
  commitAll(worktreePath: string, message: string): Promise<{ committed: boolean; sha?: string }>;

  /**
   * Rebase the worktree branch onto a target branch.
   *
   * Steps:
   *   1. Acquire repo lock
   *   2. Check if already rebased: git merge-base --is-ancestor <target> HEAD
   *   3. git rebase <targetBranch> (in worktree)
   *   4. On conflict: git rebase --abort, return { success: false, conflictFiles }
   *
   * @returns RebaseResult indicating success or conflict details
   */
  rebase(worktreePath: string, targetBranch: string): Promise<RebaseResult>;

  /**
   * Fast-forward merge a branch into the target branch.
   *
   * Steps:
   *   1. assertSafeRef(branch), assertSafeRef(targetBranch)
   *   2. Acquire repo lock
   *   3. git checkout <targetBranch> (in project repo, not worktree)
   *   4. git merge --ff-only <branch>
   *   5. Return to previous branch
   *
   * @throws MergeError if fast-forward is not possible
   */
  fastForwardMerge(
    projectPath: string,
    branch: string,
    targetBranch: string
  ): Promise<void>;

  /**
   * List existing branches in a repository.
   * READ operation — no lock required.
   */
  listBranches(projectPath: string): Promise<string[]>;

  /**
   * Check if a worktree path exists.
   */
  exists(worktreePath: string): Promise<boolean>;
}
```

### 4.2 Implementation Notes

```typescript
// services/worktree.ts — implementation sketch

import { Mutex } from '../lib/mutex.js';
import { assertSafeRef, assertSafePath } from '../lib/validation.js';
import { execCommand } from '../lib/shell.js';
import type { DiffFile } from './diff-parser.js';
import type { Logger } from 'pino';
import path from 'node:path';

/** Worktree base directory relative to project root */
const WORKTREE_DIR = '.vibe-harness-worktrees';

export function createWorktreeService(deps: {
  logger: Logger;
  diffParser: { parseUnifiedDiff: (text: string) => DiffFile[] };
}): WorktreeService {
  const { logger, diffParser } = deps;

  /**
   * Per-repository mutex prevents concurrent git write operations
   * from corrupting repository state. (SAD §5.5.1)
   *
   * Key: resolved absolute projectPath
   * Value: Mutex instance
   *
   * Read operations (getDiff, listBranches) do NOT acquire the lock.
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

  /** Run a git command in a given cwd, returning ExecResult. */
  async function git(args: string[], cwd: string) {
    return execCommand('git', args, { cwd });
  }

  async function create(
    projectPath: string,
    branchName: string,
    baseBranch: string
  ): Promise<WorktreeCreateResult> {
    assertSafeRef(branchName, 'branchName');
    assertSafeRef(baseBranch, 'baseBranch');

    const worktreePath = path.join(projectPath, WORKTREE_DIR, branchName);
    const log = logger.child({ projectPath, branchName, baseBranch });

    return getRepoLock(projectPath).runExclusive(async () => {
      log.info('Creating worktree');

      const result = await git(
        ['worktree', 'add', worktreePath, '-b', branchName, baseBranch],
        projectPath
      );

      if (result.exitCode !== 0) {
        if (result.stderr.includes('already exists')) {
          throw new BranchAlreadyExistsError(branchName);
        }
        throw new WorktreeCreateError(branchName, result.stderr);
      }

      log.info({ worktreePath }, 'Worktree created');
      return { worktreePath, branch: branchName };
    });
  }

  async function remove(
    projectPath: string,
    worktreePath: string,
    options?: { deleteBranch?: string }
  ): Promise<void> {
    const log = logger.child({ projectPath, worktreePath });

    return getRepoLock(projectPath).runExclusive(async () => {
      // Remove worktree (force to handle uncommitted changes)
      const removeResult = await git(
        ['worktree', 'remove', worktreePath, '--force'],
        projectPath
      );

      if (removeResult.exitCode !== 0) {
        // Idempotent: if worktree doesn't exist, that's fine
        if (!removeResult.stderr.includes('is not a working tree')) {
          log.warn({ stderr: removeResult.stderr }, 'Worktree remove returned error');
        }
      }

      // Prune stale worktree references
      await git(['worktree', 'prune'], projectPath);

      // Delete branch if requested
      if (options?.deleteBranch) {
        assertSafeRef(options.deleteBranch, 'deleteBranch');
        const branchResult = await git(
          ['branch', '-D', options.deleteBranch],
          projectPath
        );
        if (branchResult.exitCode !== 0) {
          log.warn(
            { stderr: branchResult.stderr },
            'Branch delete returned error (may already be deleted)'
          );
        }
      }

      log.info('Worktree removed');
    });
  }

  async function getDiff(
    worktreePath: string,
    baseBranch: string
  ): Promise<DiffResult> {
    assertSafeRef(baseBranch, 'baseBranch');

    // Find merge-base
    const mergeBaseResult = await git(
      ['merge-base', baseBranch, 'HEAD'],
      worktreePath
    );

    if (mergeBaseResult.exitCode !== 0) {
      throw new GitOperationError(
        'merge-base',
        mergeBaseResult.stderr
      );
    }

    const mergeBase = mergeBaseResult.stdout.trim();

    // Generate diff
    const diffResult = await git(
      ['diff', `${mergeBase}..HEAD`],
      worktreePath
    );

    // Parse diff stats
    const statResult = await git(
      ['diff', '--stat', `${mergeBase}..HEAD`],
      worktreePath
    );

    const rawDiff = diffResult.stdout;
    const files = diffParser.parseUnifiedDiff(rawDiff);
    const stats = parseDiffStats(statResult.stdout);

    return { rawDiff, files, stats };
  }

  async function commitAll(
    worktreePath: string,
    message: string
  ): Promise<{ committed: boolean; sha?: string }> {
    return getRepoLock(path.resolve(worktreePath, '..')).runExclusive(async () => {
      // Stage everything
      await git(['add', '-A'], worktreePath);

      // Check if there's anything to commit
      const status = await git(['status', '--porcelain'], worktreePath);
      if (!status.stdout.trim()) {
        return { committed: false };
      }

      // Commit
      const commitResult = await git(
        ['commit', '-m', message],
        worktreePath
      );

      if (commitResult.exitCode !== 0) {
        throw new GitOperationError('commit', commitResult.stderr);
      }

      // Get the commit SHA
      const shaResult = await git(['rev-parse', 'HEAD'], worktreePath);
      return { committed: true, sha: shaResult.stdout.trim() };
    });
  }

  async function rebase(
    worktreePath: string,
    targetBranch: string
  ): Promise<RebaseResult> {
    assertSafeRef(targetBranch, 'targetBranch');

    // Derive projectPath from worktree parent (for repo lock)
    const projectPath = path.resolve(worktreePath, '..', '..');

    return getRepoLock(projectPath).runExclusive(async () => {
      // Check if already rebased
      const ancestorCheck = await git(
        ['merge-base', '--is-ancestor', targetBranch, 'HEAD'],
        worktreePath
      );

      if (ancestorCheck.exitCode === 0) {
        // Already rebased — idempotent
        return { success: true };
      }

      // Attempt rebase
      const result = await git(['rebase', targetBranch], worktreePath);

      if (result.exitCode !== 0) {
        // Detect conflict
        if (result.stderr.includes('CONFLICT') || result.stderr.includes('could not apply')) {
          // Get list of conflicted files
          const conflictResult = await git(
            ['diff', '--name-only', '--diff-filter=U'],
            worktreePath
          );
          const conflictFiles = conflictResult.stdout.trim().split('\n').filter(Boolean);

          // Abort the failed rebase
          await git(['rebase', '--abort'], worktreePath);

          return { success: false, conflictFiles };
        }

        throw new GitOperationError('rebase', result.stderr);
      }

      return { success: true };
    });
  }

  async function fastForwardMerge(
    projectPath: string,
    branch: string,
    targetBranch: string
  ): Promise<void> {
    assertSafeRef(branch, 'branch');
    assertSafeRef(targetBranch, 'targetBranch');

    return getRepoLock(projectPath).runExclusive(async () => {
      // Remember current branch to restore later
      const currentBranchResult = await git(
        ['rev-parse', '--abbrev-ref', 'HEAD'],
        projectPath
      );
      const currentBranch = currentBranchResult.stdout.trim();

      try {
        // Checkout target branch
        const checkoutResult = await git(
          ['checkout', targetBranch],
          projectPath
        );
        if (checkoutResult.exitCode !== 0) {
          throw new GitOperationError('checkout', checkoutResult.stderr);
        }

        // Fast-forward merge
        const mergeResult = await git(
          ['merge', '--ff-only', branch],
          projectPath
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

  async function listBranches(projectPath: string): Promise<string[]> {
    const result = await git(
      ['branch', '--list', '--format=%(refname:short)'],
      projectPath
    );
    return result.stdout.trim().split('\n').filter(Boolean);
  }

  async function exists(worktreePath: string): Promise<boolean> {
    try {
      const result = await git(['rev-parse', '--is-inside-work-tree'], worktreePath);
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  return { create, remove, getDiff, commitAll, rebase, fastForwardMerge, listBranches, exists };
}

/** Parse git diff --stat output into structured stats */
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
```

---

## 5. ACP Client

**File:** `services/acp-client.ts`
**Responsibility:** Agent Client Protocol over stdio — NDJSON parsing, prompt sending, event stream handling. (SAD §3.3)

### 5.1 Types

```typescript
// services/acp-client.ts — types

/**
 * ACP event types emitted by Copilot CLI over stdout.
 * Each event is a single NDJSON line.
 */
export type AcpEventType =
  | 'session_update'    // Session ID, status changes
  | 'agent_message'     // Assistant text output
  | 'agent_thought'     // Reasoning/thought content
  | 'tool_call'         // Tool invocation with arguments
  | 'tool_result'       // Tool execution result
  | 'result'            // Final completion: exit code, usage stats
  | 'error';            // Protocol-level error

export interface AcpEvent {
  type: AcpEventType;
  /** Raw JSON payload (structure varies by type) */
  data: Record<string, unknown>;
  /** ISO timestamp of when the daemon received this event */
  receivedAt: string;
}

export interface AcpSessionUpdate {
  type: 'session_update';
  data: {
    sessionId: string;
    status: 'started' | 'ready' | 'completed' | 'error';
  };
}

export interface AcpAgentMessage {
  type: 'agent_message';
  data: {
    content: string;
    /** Whether this is a partial streaming chunk or complete message */
    partial: boolean;
  };
}

export interface AcpToolCall {
  type: 'tool_call';
  data: {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  };
}

export interface AcpToolResult {
  type: 'tool_result';
  data: {
    callId: string;
    output: string;
    exitCode?: number;
  };
}

export interface AcpResult {
  type: 'result';
  data: {
    exitCode: number;
    usage?: {
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      model?: string;
      duration?: number;
    };
  };
}

export interface AcpError {
  type: 'error';
  data: {
    code: string;
    message: string;
  };
}

/** Callback for processing ACP events */
export type AcpEventCallback = (event: AcpEvent) => void;

/** Options for creating an ACP connection */
export interface AcpConnectOptions {
  /** Sandbox name to exec into */
  sandboxName: string;
  /** Whether this is a continuation (--continue) */
  isContinuation: boolean;
  /** Environment variables for the copilot process */
  env?: Record<string, string>;
}

export interface AcpConnection {
  /** Unique session ID assigned by the ACP protocol */
  sessionId: string | null;
  /** Whether the ACP session is still active */
  isActive: boolean;
}
```

### 5.2 Interface

```typescript
export interface AcpClient {
  /**
   * Establish an ACP connection by executing copilot inside a sandbox.
   *
   * Steps:
   *   1. docker sandbox exec -i <sandbox> copilot --acp --stdio [--continue]
   *   2. Begin NDJSON line parsing on stdout
   *   3. Wait for session_update event with sessionId
   *   4. Return connection handle
   *
   * @param options - Sandbox name, continuation flag, env vars
   * @param onEvent - Callback invoked for every parsed ACP event
   * @throws AcpConnectionError if copilot fails to start or session not established
   */
  connect(
    options: AcpConnectOptions,
    onEvent: AcpEventCallback
  ): Promise<AcpConnection>;

  /**
   * Send a prompt message into the ACP session via stdin.
   *
   * The message is JSON-encoded and written as a single NDJSON line.
   * Must only be called when the session is active.
   *
   * @param sandboxName - Identifies which connection to write to
   * @param message - User/system message text
   * @throws AcpSessionNotActiveError if session has ended
   */
  sendPrompt(sandboxName: string, message: string): Promise<void>;

  /**
   * Send an ACP stop command to gracefully terminate the agent.
   *
   * The agent should finish its current action and exit cleanly.
   * Caller should set a timeout and force-kill if agent doesn't stop.
   *
   * @param sandboxName - Identifies which connection to stop
   */
  sendStop(sandboxName: string): Promise<void>;

  /**
   * Register an additional event listener for a connection.
   * Used by StreamingService to tap into the event stream.
   *
   * @param sandboxName - Identifies which connection to listen to
   * @param callback - Event callback
   * @returns Unsubscribe function
   */
  onEvent(sandboxName: string, callback: AcpEventCallback): () => void;

  /**
   * Get the current ACP session ID for a sandbox.
   * Returns null if no session is established.
   */
  getSessionId(sandboxName: string): string | null;

  /**
   * Check if a connection is still active.
   */
  isActive(sandboxName: string): boolean;

  /**
   * Clean up a connection (called when sandbox is stopped).
   */
  disconnect(sandboxName: string): void;
}
```

### 5.3 Implementation Notes

```typescript
// services/acp-client.ts — implementation sketch

import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Logger } from 'pino';

interface ActiveConnection {
  process: ChildProcess;
  sessionId: string | null;
  listeners: Set<AcpEventCallback>;
  isActive: boolean;
}

export function createAcpClient(deps: {
  logger: Logger;
}): AcpClient {
  const { logger } = deps;
  const connections = new Map<string, ActiveConnection>();

  async function connect(
    options: AcpConnectOptions,
    onEvent: AcpEventCallback
  ): Promise<AcpConnection> {
    const { sandboxName, isContinuation, env } = options;
    const log = logger.child({ sandboxName });

    // Build command
    const copilotArgs = ['--acp', '--stdio', '--yolo', '--autopilot'];
    if (isContinuation) {
      copilotArgs.push('--continue');
    }

    const envArgs = Object.entries(env ?? {}).flatMap(
      ([k, v]) => ['-e', `${k}=${v}`]
    );

    log.info({ isContinuation }, 'Starting ACP session');

    const child = spawn('docker', [
      'sandbox', 'exec', '-i',
      ...envArgs,
      sandboxName,
      'copilot', ...copilotArgs,
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const conn: ActiveConnection = {
      process: child,
      sessionId: null,
      listeners: new Set([onEvent]),
      isActive: true,
    };

    connections.set(sandboxName, conn);

    // Parse NDJSON from stdout line-by-line
    const rl = createInterface({ input: child.stdout! });

    rl.on('line', (line: string) => {
      if (!line.trim()) return;

      try {
        const raw = JSON.parse(line) as { type: string; [key: string]: unknown };
        const event: AcpEvent = {
          type: raw.type as AcpEventType,
          data: raw as Record<string, unknown>,
          receivedAt: new Date().toISOString(),
        };

        // Extract session ID from session_update events
        if (event.type === 'session_update' && raw.sessionId) {
          conn.sessionId = raw.sessionId as string;
          log.info({ sessionId: conn.sessionId }, 'ACP session established');
        }

        // Fan out to all listeners
        for (const listener of conn.listeners) {
          try {
            listener(event);
          } catch (err) {
            log.error({ err }, 'Error in ACP event listener');
          }
        }
      } catch (err) {
        log.warn({ line, err }, 'Failed to parse NDJSON line from ACP');
      }
    });

    // Log stderr (for diagnostics, not exposed to GUI)
    const stderrRl = createInterface({ input: child.stderr! });
    stderrRl.on('line', (line: string) => {
      log.debug({ acpStderr: line }, 'ACP stderr');
    });

    // Handle process exit
    child.on('close', (code) => {
      log.info({ exitCode: code }, 'ACP process exited');
      conn.isActive = false;

      // Emit synthetic result event if we didn't get one
      const exitEvent: AcpEvent = {
        type: 'result',
        data: { type: 'result', exitCode: code ?? 1 },
        receivedAt: new Date().toISOString(),
      };

      for (const listener of conn.listeners) {
        try { listener(exitEvent); } catch { /* ignore */ }
      }
    });

    // Wait for session to be established (with timeout)
    await waitForSession(conn, 30_000);

    return {
      sessionId: conn.sessionId,
      isActive: conn.isActive,
    };
  }

  async function sendPrompt(sandboxName: string, message: string): Promise<void> {
    const conn = connections.get(sandboxName);
    if (!conn || !conn.isActive) {
      throw new AcpSessionNotActiveError(sandboxName);
    }

    const payload = JSON.stringify({ type: 'user_message', content: message });
    conn.process.stdin!.write(payload + '\n');
  }

  async function sendStop(sandboxName: string): Promise<void> {
    const conn = connections.get(sandboxName);
    if (!conn || !conn.isActive) return; // Idempotent

    const payload = JSON.stringify({ type: 'stop' });
    conn.process.stdin!.write(payload + '\n');
  }

  function onEvent(sandboxName: string, callback: AcpEventCallback): () => void {
    const conn = connections.get(sandboxName);
    if (!conn) {
      throw new AcpConnectionNotFoundError(sandboxName);
    }

    conn.listeners.add(callback);
    return () => conn.listeners.delete(callback);
  }

  function getSessionId(sandboxName: string): string | null {
    return connections.get(sandboxName)?.sessionId ?? null;
  }

  function isActive(sandboxName: string): boolean {
    return connections.get(sandboxName)?.isActive ?? false;
  }

  function disconnect(sandboxName: string): void {
    const conn = connections.get(sandboxName);
    if (conn) {
      conn.isActive = false;
      conn.listeners.clear();
      if (!conn.process.killed) {
        conn.process.kill('SIGTERM');
      }
      connections.delete(sandboxName);
    }
  }

  return { connect, sendPrompt, sendStop, onEvent, getSessionId, isActive, disconnect };
}

/** Wait for the ACP session_update with a sessionId, or timeout. */
function waitForSession(conn: ActiveConnection, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (conn.sessionId) {
      resolve();
      return;
    }

    const timeout = setTimeout(() => {
      reject(new AcpConnectionError('Timeout waiting for ACP session initialization'));
    }, timeoutMs);

    const checkListener: AcpEventCallback = (event) => {
      if (event.type === 'session_update' && conn.sessionId) {
        clearTimeout(timeout);
        conn.listeners.delete(checkListener);
        resolve();
      }
    };

    conn.listeners.add(checkListener);

    // Also fail if process exits before session is established
    conn.process.on('close', (code) => {
      clearTimeout(timeout);
      conn.listeners.delete(checkListener);
      if (!conn.sessionId) {
        reject(new AcpConnectionError(`ACP process exited with code ${code} before session established`));
      }
    });
  });
}
```

---

## 6. Streaming Service

**File:** `services/streaming-service.ts`
**Responsibility:** Per-run event buffering with sequence numbers, DB persistence tap, WebSocket fan-out. (SAD §2.2.4, SRD FR-W19, FR-W20)

### 6.1 Interface

```typescript
// services/streaming-service.ts

export interface StreamEvent {
  /** Monotonically increasing sequence number, per run */
  seq: number;
  /** Which stage this event belongs to */
  stageName: string;
  /** The ACP event */
  event: AcpEvent;
}

export interface StreamSubscription {
  /** Unique subscriber ID */
  id: string;
  /** Callback for delivering events */
  send: (event: StreamEvent) => void;
  /** Unsubscribe */
  unsubscribe: () => void;
}

export interface StreamingService {
  /**
   * Start streaming for a workflow run.
   * Called by session-manager when a stage begins execution.
   *
   * Attaches an event listener to the ACP client for this sandbox,
   * assigns sequence numbers, buffers events, and fans out to subscribers.
   *
   * @param runId - Workflow run ID
   * @param sandboxName - Sandbox to listen to
   * @param stageName - Current stage name
   */
  startStream(runId: string, sandboxName: string, stageName: string): void;

  /**
   * Update the current stage name for a run's stream.
   * Called when advancing to a new stage within the same sandbox.
   */
  setStage(runId: string, stageName: string): void;

  /**
   * Subscribe to a run's event stream.
   * Used by WebSocket handlers to deliver events to GUI clients.
   *
   * @param runId - Workflow run ID to subscribe to
   * @param lastSeq - Last sequence number the client has seen (for replay)
   * @returns StreamSubscription with events replayed from lastSeq+1
   */
  subscribe(runId: string, lastSeq?: number): StreamSubscription;

  /**
   * Stop streaming for a workflow run.
   * Flushes any pending DB writes and cleans up resources.
   */
  stopStream(runId: string): void;

  /**
   * Get buffered events for a run from a given sequence number.
   * Used for WebSocket reconnection replay.
   *
   * @returns Events from seq+1 onwards, or null if buffer was purged
   *          (client must re-fetch from DB via GET /api/runs/:id/messages)
   */
  getBufferedEvents(runId: string, fromSeq: number): StreamEvent[] | null;
}
```

### 6.2 Implementation Notes

```typescript
// services/streaming-service.ts — implementation sketch

import type { AcpClient, AcpEvent } from './acp-client.js';
import type { Logger } from 'pino';

interface RunStream {
  runId: string;
  sandboxName: string;
  currentStageName: string;
  /** Monotonically increasing sequence counter */
  nextSeq: number;
  /** Circular buffer of recent events for replay on reconnection */
  buffer: StreamEvent[];
  /** Maximum buffer size (default: 10,000 events per run, SAD §2.2.4) */
  maxBufferSize: number;
  /** Whether the buffer has overflowed (oldest events lost) */
  bufferOverflowed: boolean;
  /** Active subscribers (WebSocket connections) */
  subscribers: Map<string, (event: StreamEvent) => void>;
  /** Unsubscribe function from ACP client */
  acpUnsubscribe: (() => void) | null;
  /** Pending DB write batch */
  pendingDbWrites: AcpEvent[];
  /** DB flush timer handle */
  flushTimer: ReturnType<typeof setInterval> | null;
}

/** DB flush interval in ms (SAD §2.2.4: 500ms or 50 events) */
const DB_FLUSH_INTERVAL = 500;
const DB_FLUSH_BATCH_SIZE = 50;

export function createStreamingService(deps: {
  logger: Logger;
  acpClient: AcpClient;
  /** Callback to persist events to runMessages table */
  persistEvents: (runId: string, stageName: string, events: AcpEvent[]) => Promise<void>;
}): StreamingService {
  const { logger, acpClient, persistEvents } = deps;
  const streams = new Map<string, RunStream>();

  function startStream(runId: string, sandboxName: string, stageName: string): void {
    const log = logger.child({ runId, sandboxName, stageName });

    // Idempotent: reuse existing stream if already started
    if (streams.has(runId)) {
      log.debug('Stream already started, updating stage');
      streams.get(runId)!.currentStageName = stageName;
      return;
    }

    const stream: RunStream = {
      runId,
      sandboxName,
      currentStageName: stageName,
      nextSeq: 1,
      buffer: [],
      maxBufferSize: 10_000,
      bufferOverflowed: false,
      subscribers: new Map(),
      acpUnsubscribe: null,
      pendingDbWrites: [],
      flushTimer: null,
    };

    // Subscribe to ACP events for this sandbox
    stream.acpUnsubscribe = acpClient.onEvent(sandboxName, (event: AcpEvent) => {
      const streamEvent: StreamEvent = {
        seq: stream.nextSeq++,
        stageName: stream.currentStageName,
        event,
      };

      // Append to buffer (ring buffer behavior)
      if (stream.buffer.length >= stream.maxBufferSize) {
        stream.buffer.shift(); // Drop oldest
        stream.bufferOverflowed = true;
      }
      stream.buffer.push(streamEvent);

      // Queue for DB persistence
      stream.pendingDbWrites.push(event);
      if (stream.pendingDbWrites.length >= DB_FLUSH_BATCH_SIZE) {
        flushToDb(stream);
      }

      // Fan out to all active subscribers
      for (const [subId, send] of stream.subscribers) {
        try {
          send(streamEvent);
        } catch (err) {
          log.warn({ subId, err }, 'Error sending to subscriber, removing');
          stream.subscribers.delete(subId);
        }
      }
    });

    // Periodic DB flush timer
    stream.flushTimer = setInterval(() => flushToDb(stream), DB_FLUSH_INTERVAL);

    streams.set(runId, stream);
    log.info('Stream started');
  }

  function setStage(runId: string, stageName: string): void {
    const stream = streams.get(runId);
    if (stream) {
      stream.currentStageName = stageName;
    }
  }

  function subscribe(runId: string, lastSeq?: number): StreamSubscription {
    const stream = streams.get(runId);
    const subId = crypto.randomUUID();

    if (!stream) {
      // Run not currently streaming — return empty subscription
      // Client should fetch historical events from DB
      return {
        id: subId,
        send: () => {},
        unsubscribe: () => {},
      };
    }

    let sendFn: (event: StreamEvent) => void = () => {};

    const subscription: StreamSubscription = {
      id: subId,
      get send() { return sendFn; },
      set send(fn) {
        sendFn = fn;
        stream.subscribers.set(subId, fn);
      },
      unsubscribe: () => {
        stream.subscribers.delete(subId);
      },
    };

    // Replay buffered events from lastSeq+1
    if (lastSeq !== undefined) {
      if (stream.bufferOverflowed && stream.buffer.length > 0 && stream.buffer[0].seq > lastSeq + 1) {
        // Client missed events that were evicted from the buffer.
        // Send a resync_required signal — client must re-fetch from DB.
        const resyncEvent: StreamEvent = {
          seq: -1,
          stageName: stream.currentStageName,
          event: {
            type: 'error',
            data: { type: 'error', code: 'resync_required', message: 'Buffer overflow — re-fetch from API' },
            receivedAt: new Date().toISOString(),
          },
        };
        sendFn(resyncEvent);
      } else {
        // Replay missed events
        for (const buffered of stream.buffer) {
          if (buffered.seq > (lastSeq ?? 0)) {
            sendFn(buffered);
          }
        }
      }
    }

    stream.subscribers.set(subId, sendFn);
    return subscription;
  }

  function stopStream(runId: string): void {
    const stream = streams.get(runId);
    if (!stream) return;

    // Flush remaining DB writes
    flushToDb(stream);

    // Cleanup
    if (stream.flushTimer) clearInterval(stream.flushTimer);
    if (stream.acpUnsubscribe) stream.acpUnsubscribe();
    stream.subscribers.clear();
    streams.delete(runId);

    logger.info({ runId }, 'Stream stopped');
  }

  function getBufferedEvents(runId: string, fromSeq: number): StreamEvent[] | null {
    const stream = streams.get(runId);
    if (!stream) return null;

    if (stream.bufferOverflowed && stream.buffer.length > 0 && stream.buffer[0].seq > fromSeq + 1) {
      return null; // Gap in buffer — client must re-fetch from DB
    }

    return stream.buffer.filter((e) => e.seq > fromSeq);
  }

  /** Flush pending events to DB (batched write, SAD §2.2.4) */
  async function flushToDb(stream: RunStream): Promise<void> {
    if (stream.pendingDbWrites.length === 0) return;

    const batch = stream.pendingDbWrites.splice(0);
    try {
      await persistEvents(stream.runId, stream.currentStageName, batch);
    } catch (err) {
      logger.error({ runId: stream.runId, batchSize: batch.length, err }, 'Failed to flush events to DB');
      // Re-queue failed batch at the front (will retry on next flush)
      stream.pendingDbWrites.unshift(...batch);
    }
  }

  return { startStream, setStage, subscribe, stopStream, getBufferedEvents };
}
```

---

## 7. Review Service

**File:** `services/review-service.ts`
**Responsibility:** Auto-create reviews from diffs, generate AI summaries, capture plan.md, bundle comments for re-injection. (SAD §5.3.1, SRD §2.6 FR-R1–R11)

### 7.1 Interface

```typescript
// services/review-service.ts

export interface CreateReviewOptions {
  /** Workflow run ID */
  runId: string;
  /** Stage name (null for consolidation reviews) */
  stageName: string | null;
  /** Review round (increments on request_changes) */
  round: number;
  /** Review type */
  type: 'stage' | 'consolidation';
  /** Worktree path for generating the diff */
  worktreePath: string;
  /** Base branch to compute merge-base diff against */
  baseBranch: string;
  /** Sandbox name for capturing plan.md */
  sandboxName?: string;
}

export interface ReviewResult {
  /** Created review ID */
  reviewId: string;
  /** Whether this was an existing review (idempotent) */
  alreadyExisted: boolean;
}

export interface BundledComments {
  /** Formatted markdown string ready for ACP injection */
  markdown: string;
  /** Number of comments included */
  commentCount: number;
}

export interface ReviewService {
  /**
   * Create a review for a completed stage or consolidation.
   *
   * Steps (SAD §5.3.1):
   *   1. Check for existing review (idempotent — UNIQUE constraint)
   *   2. Generate diff via WorktreeService.getDiff()
   *   3. Capture plan.md from sandbox filesystem (if exists)
   *   4. Generate AI summary of the diff (call LLM)
   *   5. Insert review record in DB
   *   6. Return review ID
   *
   * @returns ReviewResult with ID and idempotency flag
   * @throws ReviewCreateError if diff generation fails
   */
  createReview(options: CreateReviewOptions): Promise<ReviewResult>;

  /**
   * Bundle all comments on a review into a markdown prompt
   * for injection into the agent conversation.
   *
   * Output format:
   * ```markdown
   * ## Review Feedback (Round N)
   *
   * ### General Comments
   * - Comment text here
   *
   * ### File: src/app.ts
   * - **Line 42:** Comment about this line
   * - **Line 87:** Another comment
   *
   * ### File: src/utils.ts
   * - **Line 15:** Fix this function
   * ```
   *
   * @param reviewId - Review to bundle comments from
   * @returns Formatted markdown and comment count
   */
  bundleCommentsAsPrompt(reviewId: string): Promise<BundledComments>;

  /**
   * Get the diff for a workflow run's current worktree state.
   * Delegates to WorktreeService.getDiff().
   *
   * @param runId - Workflow run ID (looks up worktreePath + baseBranch from DB)
   */
  getDiff(runId: string): Promise<DiffResult>;

  /**
   * Capture plan.md content from a sandbox's filesystem.
   * Returns null if plan.md doesn't exist.
   *
   * @param sandboxName - Sandbox to read from
   */
  capturePlanMarkdown(sandboxName: string): Promise<string | null>;
}
```

### 7.2 Implementation Notes

```typescript
// services/review-service.ts — implementation sketch

import type { WorktreeService, DiffResult } from './worktree.js';
import type { SandboxService } from './sandbox.js';
import type { DrizzleDb } from '../db/index.js';
import type { Logger } from 'pino';

export function createReviewService(deps: {
  logger: Logger;
  db: DrizzleDb;
  worktreeService: WorktreeService;
  sandboxService: SandboxService;
}): ReviewService {
  const { logger, db, worktreeService, sandboxService } = deps;

  async function createReview(options: CreateReviewOptions): Promise<ReviewResult> {
    const log = logger.child({
      runId: options.runId,
      stageName: options.stageName,
      round: options.round,
      type: options.type,
    });

    // Step 1: Check for existing review (idempotent replay, SAD §4.1)
    const existing = await db.query.reviews.findFirst({
      where: (r, { and, eq }) => and(
        eq(r.workflowRunId, options.runId),
        options.stageName ? eq(r.stageName, options.stageName) : undefined,
        eq(r.round, options.round),
        eq(r.type, options.type),
      ),
    });

    if (existing) {
      log.info({ reviewId: existing.id }, 'Review already exists (idempotent)');
      return { reviewId: existing.id, alreadyExisted: true };
    }

    // Step 2: Generate diff
    log.info('Generating diff for review');
    const diff = await worktreeService.getDiff(options.worktreePath, options.baseBranch);

    // Step 3: Capture plan.md (best-effort)
    let planMarkdown: string | null = null;
    if (options.sandboxName) {
      planMarkdown = await capturePlanMarkdown(options.sandboxName);
    }

    // Step 4: Generate AI summary
    const aiSummary = await generateAiSummary(diff, log);

    // Step 5: Insert review record
    const reviewId = crypto.randomUUID();
    await db.insert(reviews).values({
      id: reviewId,
      workflowRunId: options.runId,
      stageName: options.stageName,
      round: options.round,
      type: options.type,
      status: 'pending_review',
      aiSummary,
      diffSnapshot: diff.rawDiff,
      planMarkdown,
      createdAt: new Date().toISOString(),
    });

    log.info({ reviewId }, 'Review created');
    return { reviewId, alreadyExisted: false };
  }

  async function bundleCommentsAsPrompt(reviewId: string): Promise<BundledComments> {
    const comments = await db.query.reviewComments.findMany({
      where: (c, { eq }) => eq(c.reviewId, reviewId),
      orderBy: (c, { asc }) => [asc(c.filePath), asc(c.lineNumber)],
    });

    if (comments.length === 0) {
      return { markdown: '', commentCount: 0 };
    }

    // Group by file
    const generalComments: string[] = [];
    const fileComments = new Map<string, Array<{ line?: number; body: string }>>();

    for (const comment of comments) {
      if (!comment.filePath) {
        generalComments.push(comment.body);
      } else {
        const existing = fileComments.get(comment.filePath) ?? [];
        existing.push({ line: comment.lineNumber ?? undefined, body: comment.body });
        fileComments.set(comment.filePath, existing);
      }
    }

    // Build markdown
    const lines: string[] = [`## Review Feedback (Round ${comments.length > 0 ? 'N' : '1'})`, ''];

    if (generalComments.length > 0) {
      lines.push('### General Comments', '');
      for (const comment of generalComments) {
        lines.push(`- ${comment}`);
      }
      lines.push('');
    }

    for (const [filePath, fileCommentsList] of fileComments) {
      lines.push(`### File: ${filePath}`, '');
      for (const comment of fileCommentsList) {
        if (comment.line) {
          lines.push(`- **Line ${comment.line}:** ${comment.body}`);
        } else {
          lines.push(`- ${comment.body}`);
        }
      }
      lines.push('');
    }

    lines.push(
      'Please address each comment above. If you disagree with a suggestion, explain your reasoning.'
    );

    return { markdown: lines.join('\n'), commentCount: comments.length };
  }

  async function getDiff(runId: string): Promise<DiffResult> {
    const run = await db.query.workflowRuns.findFirst({
      where: (r, { eq }) => eq(r.id, runId),
    });

    if (!run) throw new RunNotFoundError(runId);
    if (!run.worktreePath) throw new WorktreeNotReadyError(runId);

    return worktreeService.getDiff(run.worktreePath, run.baseBranch!);
  }

  async function capturePlanMarkdown(sandboxName: string): Promise<string | null> {
    try {
      const result = await sandboxService.exec(sandboxName, {
        command: ['cat', '/home/user/plan.md'],
      }) as import('../lib/shell.js').ExecResult;

      if (result.exitCode === 0 && result.stdout.trim()) {
        return result.stdout;
      }
      return null;
    } catch {
      return null; // plan.md doesn't exist — that's fine
    }
  }

  return { createReview, bundleCommentsAsPrompt, getDiff, capturePlanMarkdown };
}

/**
 * Generate an AI summary of a diff using a lightweight LLM call.
 * Falls back to a simple statistical summary on failure.
 */
async function generateAiSummary(diff: DiffResult, log: Logger): Promise<string> {
  // TODO: Implement LLM call for AI summary generation.
  // For now, return a structured statistical summary.
  const { stats, files } = diff;

  const fileList = files.map((f) => `- ${f.newPath ?? f.oldPath}`).join('\n');

  return [
    `**${stats.filesChanged}** files changed, `,
    `**${stats.insertions}** insertions(+), `,
    `**${stats.deletions}** deletions(-)`,
    '',
    'Files:',
    fileList,
  ].join('\n');
}
```

---

## 8. Credential Vault

**File:** `services/credential-vault.ts`
**Responsibility:** Encrypted credential storage, decryption, and sandbox injection argument building. (SAD §6, SRD §2.7 FR-C1–C8)

### 8.1 Types

```typescript
// services/credential-vault.ts — types

export type CredentialEntryType =
  | 'env_var'
  | 'file_mount'
  | 'docker_login'
  | 'host_dir_mount'
  | 'command_extract';

export interface CredentialSetInput {
  name: string;
  description?: string;
  /** If set, scoped to this project. Null = global. */
  projectId?: string | null;
}

export interface CredentialEntryInput {
  credentialSetId: string;
  /** Key meaning varies by type (see SAD §4.2 credentialEntries) */
  key: string;
  /** Plaintext value — will be encrypted before storage */
  value: string;
  type: CredentialEntryType;
  /** Target path in sandbox (for file_mount and host_dir_mount) */
  mountPath?: string;
  /** Host command to run (for command_extract) */
  command?: string;
}

export interface CredentialEntry {
  id: string;
  credentialSetId: string;
  key: string;
  /** Always '***' when returned via API (FR-C7) */
  maskedValue: string;
  type: CredentialEntryType;
  mountPath?: string | null;
  command?: string | null;
  createdAt: string;
}

export interface DecryptedCredentialEntry extends Omit<CredentialEntry, 'maskedValue'> {
  /** Plaintext value — NEVER exposed via API or logs (FR-C7, FR-C8) */
  value: string;
}

/** Audit log entry for credential access tracking (FR-C5) */
export interface CredentialAuditEntry {
  action: 'created' | 'deleted' | 'accessed';
  credentialSetId?: string;
  credentialEntryId?: string;
  workflowRunId?: string;
  details?: Record<string, unknown>;
}
```

### 8.2 Interface

```typescript
export interface CredentialVault {
  /**
   * Create a new credential set.
   */
  createSet(input: CredentialSetInput): Promise<string>;

  /**
   * Add an encrypted credential entry to a set.
   *
   * Steps:
   *   1. Encrypt value using AES-256 (key from Keychain/libsecret/file)
   *   2. Insert into credentialEntries table
   *   3. Write audit log entry
   *
   * @returns Entry ID
   */
  addEntry(input: CredentialEntryInput): Promise<string>;

  /**
   * Get entries for a credential set (values masked as '***').
   * Safe for API responses (FR-C7).
   */
  getEntries(credentialSetId: string): Promise<CredentialEntry[]>;

  /**
   * Get decrypted entries for a credential set.
   * ONLY used internally by buildSandboxCredentials().
   * NEVER returned via API.
   *
   * @param workflowRunId - For audit logging (FR-C5)
   */
  getDecryptedEntries(
    credentialSetId: string,
    workflowRunId: string
  ): Promise<DecryptedCredentialEntry[]>;

  /**
   * Delete a credential entry.
   */
  deleteEntry(entryId: string): Promise<void>;

  /**
   * Delete an entire credential set and all its entries.
   */
  deleteSet(credentialSetId: string): Promise<void>;

  /**
   * Build SandboxCredentials from a credential set.
   * This is the main integration point — called by session-manager
   * before sandbox creation.
   *
   * Steps for each entry type (SAD §6.2):
   *   1. env_var: decrypt value → add to envVars[]
   *   2. file_mount: decrypt value → add to fileMounts[]
   *   3. docker_login: decrypt value (JSON) → add to dockerLogins[]
   *   4. host_dir_mount: decrypt value (host path) → add to hostDirMounts[]
   *   5. command_extract: run entry.command on HOST → capture stdout → add to envVars[]
   *
   * Writes audit log entry with workflowRunId.
   *
   * @param credentialSetId - Credential set to build from
   * @param workflowRunId - For audit logging
   * @throws CommandExtractError if a command_extract entry fails
   */
  buildSandboxCredentials(
    credentialSetId: string,
    workflowRunId: string
  ): Promise<SandboxCredentials>;

  /**
   * Get audit log entries for a credential set.
   */
  getAuditLog(credentialSetId: string): Promise<CredentialAuditEntry[]>;
}
```

### 8.3 Implementation Notes

```typescript
// services/credential-vault.ts — implementation sketch

import { encrypt, decrypt } from '../lib/encryption.js';
import { execCommand } from '../lib/shell.js';
import type { DrizzleDb } from '../db/index.js';
import type { SandboxCredentials } from './sandbox.js';
import type { Logger } from 'pino';

/**
 * AES-256-GCM encryption.
 * Key source priority (SAD §6.1):
 *   1. macOS Keychain (via security find-generic-password)
 *   2. Linux libsecret (via secret-tool)
 *   3. File fallback: ~/.vibe-harness/encryption.key (0600 permissions)
 */

export function createCredentialVault(deps: {
  logger: Logger;
  db: DrizzleDb;
  /** Returns the AES-256 key bytes from the platform keystore */
  getEncryptionKey: () => Promise<Buffer>;
}): CredentialVault {
  const { logger, db, getEncryptionKey } = deps;

  async function addEntry(input: CredentialEntryInput): Promise<string> {
    const key = await getEncryptionKey();
    const encryptedValue = encrypt(input.value, key);

    const entryId = crypto.randomUUID();
    await db.insert(credentialEntries).values({
      id: entryId,
      credentialSetId: input.credentialSetId,
      key: input.key,
      value: encryptedValue, // AES-256-GCM encrypted
      type: input.type,
      mountPath: input.mountPath ?? null,
      command: input.command ?? null,
      createdAt: new Date().toISOString(),
    });

    await writeAuditLog({
      action: 'created',
      credentialSetId: input.credentialSetId,
      credentialEntryId: entryId,
    });

    return entryId;
  }

  async function getDecryptedEntries(
    credentialSetId: string,
    workflowRunId: string
  ): Promise<DecryptedCredentialEntry[]> {
    const key = await getEncryptionKey();

    const entries = await db.query.credentialEntries.findMany({
      where: (e, { eq }) => eq(e.credentialSetId, credentialSetId),
    });

    // Audit log: credential access (FR-C5)
    await writeAuditLog({
      action: 'accessed',
      credentialSetId,
      workflowRunId,
      details: { entryCount: entries.length },
    });

    return entries.map((entry) => ({
      id: entry.id,
      credentialSetId: entry.credentialSetId,
      key: entry.key,
      value: decrypt(entry.value, key),
      type: entry.type as CredentialEntryType,
      mountPath: entry.mountPath,
      command: entry.command,
      createdAt: entry.createdAt,
    }));
  }

  async function buildSandboxCredentials(
    credentialSetId: string,
    workflowRunId: string
  ): Promise<SandboxCredentials> {
    const log = logger.child({ credentialSetId, workflowRunId });
    const entries = await getDecryptedEntries(credentialSetId, workflowRunId);

    const creds: SandboxCredentials = {
      envVars: [],
      fileMounts: [],
      dockerLogins: [],
      hostDirMounts: [],
    };

    for (const entry of entries) {
      switch (entry.type) {
        case 'env_var':
          creds.envVars.push({ key: entry.key, value: entry.value });
          break;

        case 'file_mount':
          if (!entry.mountPath) {
            log.warn({ entryId: entry.id }, 'file_mount entry missing mountPath, skipping');
            break;
          }
          creds.fileMounts.push({ mountPath: entry.mountPath, content: entry.value });
          break;

        case 'docker_login': {
          const loginData = JSON.parse(entry.value) as { username: string; password: string };
          creds.dockerLogins.push({
            registry: entry.key,
            username: loginData.username,
            password: loginData.password,
          });
          break;
        }

        case 'host_dir_mount':
          if (!entry.mountPath) {
            log.warn({ entryId: entry.id }, 'host_dir_mount entry missing mountPath, skipping');
            break;
          }
          creds.hostDirMounts.push({
            hostPath: entry.value, // value = host directory path
            containerPath: entry.mountPath,
          });
          break;

        case 'command_extract': {
          // Execute command on HOST, capture output as env var (SAD §6.2)
          if (!entry.command) {
            log.warn({ entryId: entry.id }, 'command_extract entry missing command, skipping');
            break;
          }
          log.info({ key: entry.key }, 'Running command extract on host');
          const result = await execCommand('sh', ['-c', entry.command], {
            timeout: 30_000,
          });
          if (result.exitCode !== 0) {
            throw new CommandExtractError(
              entry.key,
              entry.command,
              result.stderr
            );
          }
          creds.envVars.push({ key: entry.key, value: result.stdout.trim() });
          break;
        }
      }
    }

    // NEVER log credential values (FR-C8)
    log.info({
      envVarCount: creds.envVars.length,
      fileMountCount: creds.fileMounts.length,
      dockerLoginCount: creds.dockerLogins.length,
      hostDirMountCount: creds.hostDirMounts.length,
    }, 'Built sandbox credentials');

    return creds;
  }

  async function writeAuditLog(entry: CredentialAuditEntry): Promise<void> {
    await db.insert(credentialAuditLog).values({
      id: crypto.randomUUID(),
      action: entry.action,
      credentialSetId: entry.credentialSetId ?? null,
      credentialEntryId: entry.credentialEntryId ?? null,
      workflowRunId: entry.workflowRunId ?? null,
      details: entry.details ? JSON.stringify(entry.details) : null,
      createdAt: new Date().toISOString(),
    });
  }

  // createSet, getEntries, deleteEntry, deleteSet, getAuditLog
  // follow standard Drizzle CRUD patterns — omitted for brevity.

  return {
    createSet: async (input) => { /* standard insert */ return crypto.randomUUID(); },
    addEntry,
    getEntries: async (setId) => {
      const entries = await db.query.credentialEntries.findMany({
        where: (e, { eq }) => eq(e.credentialSetId, setId),
      });
      return entries.map((e) => ({ ...e, maskedValue: '***' })) as CredentialEntry[];
    },
    getDecryptedEntries,
    deleteEntry: async (id) => {
      await db.delete(credentialEntries).where(eq(credentialEntries.id, id));
      await writeAuditLog({ action: 'deleted', credentialEntryId: id });
    },
    deleteSet: async (id) => {
      await db.delete(credentialSets).where(eq(credentialSets.id, id));
      await writeAuditLog({ action: 'deleted', credentialSetId: id });
    },
    buildSandboxCredentials,
    getAuditLog: async (setId) => {
      return db.query.credentialAuditLog.findMany({
        where: (a, { eq }) => eq(a.credentialSetId, setId),
        orderBy: (a, { desc }) => [desc(a.createdAt)],
      }) as unknown as CredentialAuditEntry[];
    },
  };
}
```

### 8.4 Encryption Module

```typescript
// lib/encryption.ts

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;  // 96 bits for GCM
const TAG_LENGTH = 16; // 128 bits

/**
 * Encrypt a plaintext string using AES-256-GCM.
 * Returns base64-encoded string: iv + ciphertext + authTag
 */
export function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  // Pack: iv (12) + encrypted (variable) + authTag (16)
  const packed = Buffer.concat([iv, encrypted, authTag]);
  return packed.toString('base64');
}

/**
 * Decrypt an AES-256-GCM encrypted string.
 * Input: base64-encoded iv + ciphertext + authTag
 */
export function decrypt(encryptedBase64: string, key: Buffer): string {
  const packed = Buffer.from(encryptedBase64, 'base64');

  const iv = packed.subarray(0, IV_LENGTH);
  const authTag = packed.subarray(packed.length - TAG_LENGTH);
  const ciphertext = packed.subarray(IV_LENGTH, packed.length - TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return decrypted.toString('utf8');
}

/**
 * Get or create the AES-256 encryption key.
 * Priority (SAD §6.1):
 *   1. macOS Keychain
 *   2. Linux libsecret
 *   3. File fallback (~/.vibe-harness/encryption.key, 0600)
 */
export async function getOrCreateEncryptionKey(): Promise<Buffer> {
  // Try platform keystore first
  const platformKey = await getPlatformKey();
  if (platformKey) return platformKey;

  // File fallback
  const keyPath = path.join(os.homedir(), '.vibe-harness', 'encryption.key');

  try {
    const existing = await fs.readFile(keyPath);
    return existing;
  } catch {
    // Generate new key
    const newKey = randomBytes(32); // 256 bits
    await fs.mkdir(path.dirname(keyPath), { recursive: true });
    await fs.writeFile(keyPath, newKey, { mode: 0o600 });
    return newKey;
  }
}

async function getPlatformKey(): Promise<Buffer | null> {
  if (process.platform === 'darwin') {
    // macOS Keychain
    try {
      const result = await execCommand('security', [
        'find-generic-password',
        '-s', 'vibe-harness',
        '-a', 'encryption-key',
        '-w',
      ]);
      if (result.exitCode === 0 && result.stdout.trim()) {
        return Buffer.from(result.stdout.trim(), 'base64');
      }
    } catch { /* fall through */ }
  }

  if (process.platform === 'linux') {
    // libsecret
    try {
      const result = await execCommand('secret-tool', [
        'lookup', 'application', 'vibe-harness', 'type', 'encryption-key',
      ]);
      if (result.exitCode === 0 && result.stdout.trim()) {
        return Buffer.from(result.stdout.trim(), 'base64');
      }
    } catch { /* fall through */ }
  }

  return null; // Fall through to file-based key
}
```

---

## 9. Branch Namer

**File:** `services/branch-namer.ts`
**Responsibility:** Generate LLM-based branch names from run descriptions, sanitize to valid git ref format, deduplicate against existing branches. (SAD §5.5.2, SRD FR-W18)

### 9.1 Interface

```typescript
// services/branch-namer.ts

export interface BranchNamer {
  /**
   * Generate a branch name from a run/proposal description.
   *
   * Steps:
   *   1. Call LLM to generate a short, descriptive branch name
   *   2. Sanitize to valid git ref format
   *   3. Deduplicate against existing branches
   *   4. Fallback: <prefix>-<shortId> if LLM fails
   *
   * @param description - Human-readable run/proposal description
   * @param existingBranches - Current branches to avoid duplicates
   * @param options - Prefix and fallback configuration
   * @returns A unique, valid git branch name
   */
  generate(
    description: string,
    existingBranches: string[],
    options?: {
      /** Branch name prefix (default: 'vibe-harness') */
      prefix?: string;
      /** Short ID for fallback name (e.g., first 8 chars of run ID) */
      shortId?: string;
    }
  ): Promise<string>;

  /**
   * Sanitize a raw string into a valid git ref name.
   *
   * Rules (SAD §10.1):
   *   - Replace spaces and underscores with hyphens
   *   - Remove characters outside [a-zA-Z0-9._/-]
   *   - Collapse consecutive hyphens/dots
   *   - Remove leading/trailing hyphens and dots
   *   - Truncate to 60 characters (git refs can be 255 but keep short)
   *   - Lowercase
   */
  sanitize(name: string): string;

  /**
   * Ensure a branch name is unique by appending a numeric suffix.
   *
   * Examples:
   *   fix-login-bug → fix-login-bug (if unique)
   *   fix-login-bug → fix-login-bug-2 (if exists)
   *   fix-login-bug → fix-login-bug-3 (if -2 also exists)
   */
  deduplicate(name: string, existingBranches: string[]): string;
}
```

### 9.2 Implementation

```typescript
// services/branch-namer.ts — implementation

import type { Logger } from 'pino';

export function createBranchNamer(deps: {
  logger: Logger;
  /** Lightweight LLM call for name generation */
  llmCall: (prompt: string) => Promise<string>;
}): BranchNamer {
  const { logger, llmCall } = deps;

  function sanitize(name: string): string {
    return name
      .toLowerCase()
      .trim()
      .replace(/[\s_]+/g, '-')            // spaces/underscores → hyphens
      .replace(/[^a-z0-9.\-/]/g, '')      // remove invalid chars
      .replace(/-{2,}/g, '-')             // collapse consecutive hyphens
      .replace(/\.{2,}/g, '.')            // collapse consecutive dots
      .replace(/^[-./]+|[-./]+$/g, '')    // trim leading/trailing special chars
      .slice(0, 60);                      // max length
  }

  function deduplicate(name: string, existingBranches: string[]): string {
    const branchSet = new Set(existingBranches);

    if (!branchSet.has(name)) return name;

    let suffix = 2;
    while (branchSet.has(`${name}-${suffix}`)) {
      suffix++;
    }
    return `${name}-${suffix}`;
  }

  async function generate(
    description: string,
    existingBranches: string[],
    options?: { prefix?: string; shortId?: string }
  ): Promise<string> {
    const prefix = options?.prefix ?? 'vibe-harness';
    const shortId = options?.shortId ?? crypto.randomUUID().slice(0, 8);
    const fallback = `${prefix}/run-${shortId}`;

    try {
      const prompt = [
        'Generate a short git branch name (2-5 words, hyphen-separated) for this task:',
        '',
        description,
        '',
        'Rules:',
        '- Use lowercase letters, numbers, and hyphens only',
        '- No more than 40 characters',
        '- Be descriptive but concise',
        '- Do not include any prefix',
        '',
        'Respond with ONLY the branch name, nothing else.',
      ].join('\n');

      const raw = await llmCall(prompt);
      const cleaned = raw.trim().split('\n')[0].trim(); // Take first line only

      if (!cleaned || cleaned.length < 3) {
        logger.warn({ description }, 'LLM returned empty/short branch name, using fallback');
        return deduplicate(fallback, existingBranches);
      }

      const sanitized = sanitize(cleaned);
      if (!sanitized || sanitized.length < 3) {
        return deduplicate(fallback, existingBranches);
      }

      return deduplicate(sanitized, existingBranches);
    } catch (err) {
      logger.warn({ err, description }, 'LLM branch name generation failed, using fallback');
      return deduplicate(fallback, existingBranches);
    }
  }

  return { generate, sanitize, deduplicate };
}
```

---

## 10. Diff Parser

**File:** `services/diff-parser.ts`
**Responsibility:** Parse unified diff text into structured types for the review UI. (SRD FR-R2, FR-R3)

### 10.1 Types

```typescript
// services/diff-parser.ts — types

export type DiffLineType = 'add' | 'delete' | 'context';

export interface DiffLine {
  /** Line type: added, deleted, or context (unchanged) */
  type: DiffLineType;
  /** Line content (without +/- prefix) */
  content: string;
  /** Line number in the old file (null for additions) */
  oldLineNumber: number | null;
  /** Line number in the new file (null for deletions) */
  newLineNumber: number | null;
}

export interface DiffHunk {
  /** Hunk header: @@ -oldStart,oldCount +newStart,newCount @@ */
  header: string;
  /** Old file start line */
  oldStart: number;
  /** Old file line count */
  oldCount: number;
  /** New file start line */
  newStart: number;
  /** New file line count */
  newCount: number;
  /** Optional hunk context (function name, class name) */
  context?: string;
  /** Lines in this hunk */
  lines: DiffLine[];
}

export type DiffFileStatus = 'added' | 'deleted' | 'modified' | 'renamed';

export interface DiffFile {
  /** Old file path (null for new files) */
  oldPath: string | null;
  /** New file path (null for deleted files) */
  newPath: string | null;
  /** File change status */
  status: DiffFileStatus;
  /** Whether the file is binary */
  isBinary: boolean;
  /** Diff hunks */
  hunks: DiffHunk[];
  /** Stats for this file */
  additions: number;
  deletions: number;
}
```

### 10.2 Implementation

```typescript
// services/diff-parser.ts — implementation

/**
 * Parse a unified diff text into structured DiffFile[].
 * Handles:
 *   - Standard unified diff format (git diff output)
 *   - New/deleted files (--- /dev/null or +++ /dev/null)
 *   - Renamed files (rename from/to)
 *   - Binary files
 *
 * This is a pure function with no dependencies.
 */
export function parseUnifiedDiff(diffText: string): DiffFile[] {
  const files: DiffFile[] = [];
  const lines = diffText.split('\n');
  let i = 0;

  while (i < lines.length) {
    // Find the start of a file diff (diff --git a/... b/...)
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
    while (i < lines.length && !lines[i].startsWith('diff --git') && !lines[i].startsWith('@@')) {
      const line = lines[i];

      if (line.startsWith('--- ')) {
        const path = line.slice(4);
        file.oldPath = path === '/dev/null' ? null : path.replace(/^[ab]\//, '');
      } else if (line.startsWith('+++ ')) {
        const path = line.slice(4);
        file.newPath = path === '/dev/null' ? null : path.replace(/^[ab]\//, '');
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

/** Parse a single hunk starting at the @@ line */
function parseHunk(
  lines: string[],
  startIndex: number
): { hunk: DiffHunk; additions: number; deletions: number; nextIndex: number } {
  const headerLine = lines[startIndex];
  const headerMatch = headerLine.match(
    /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@\s*(.*)?$/
  );

  if (!headerMatch) {
    return {
      hunk: {
        header: headerLine,
        oldStart: 0, oldCount: 0,
        newStart: 0, newCount: 0,
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

  while (i < lines.length && !lines[i].startsWith('@@') && !lines[i].startsWith('diff --git')) {
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
      break; // Unknown line format — end of hunk
    }

    i++;
  }

  return { hunk, additions, deletions, nextIndex: i };
}
```

---

## 11. Error Types

**File:** `lib/errors.ts`
**Reference:** SAD §10.2

All errors extend a base `AppError` class that includes an error code for HTTP mapping.

### 11.1 Base Error

```typescript
// lib/errors.ts

/**
 * Base error class for all application errors.
 * Includes a machine-readable code for HTTP status mapping.
 */
export abstract class AppError extends Error {
  abstract readonly code: string;
  abstract readonly httpStatus: number;
  readonly details?: Record<string, unknown>;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = this.constructor.name;
    this.details = details;
  }

  /** Serialize to API error response format (SAD §3.1) */
  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        details: this.details ?? {},
      },
    };
  }
}

/**
 * Fatal errors skip workflow retry and should crash the operation.
 * Used for unrecoverable situations (corrupt DB, filesystem errors).
 */
export class FatalError extends AppError {
  readonly code = 'FATAL_ERROR';
  readonly httpStatus = 500;
}
```

### 11.2 Entity Not Found Errors (404)

```typescript
export class RunNotFoundError extends AppError {
  readonly code = 'RUN_NOT_FOUND';
  readonly httpStatus = 404;
  constructor(runId: string) {
    super(`Workflow run with ID ${runId} does not exist`, { runId });
  }
}

export class ReviewNotFoundError extends AppError {
  readonly code = 'REVIEW_NOT_FOUND';
  readonly httpStatus = 404;
  constructor(reviewId: string) {
    super(`Review with ID ${reviewId} does not exist`, { reviewId });
  }
}

export class ProjectNotFoundError extends AppError {
  readonly code = 'PROJECT_NOT_FOUND';
  readonly httpStatus = 404;
  constructor(projectId: string) {
    super(`Project with ID ${projectId} does not exist`, { projectId });
  }
}

export class WorkflowTemplateNotFoundError extends AppError {
  readonly code = 'WORKFLOW_TEMPLATE_NOT_FOUND';
  readonly httpStatus = 404;
  constructor(templateId: string) {
    super(`Workflow template with ID ${templateId} does not exist`, { templateId });
  }
}

export class CredentialSetNotFoundError extends AppError {
  readonly code = 'CREDENTIAL_SET_NOT_FOUND';
  readonly httpStatus = 404;
  constructor(setId: string) {
    super(`Credential set with ID ${setId} does not exist`, { setId });
  }
}

export class ProposalNotFoundError extends AppError {
  readonly code = 'PROPOSAL_NOT_FOUND';
  readonly httpStatus = 404;
  constructor(proposalId: string) {
    super(`Proposal with ID ${proposalId} does not exist`, { proposalId });
  }
}
```

### 11.3 State Validation Errors (409 Conflict)

```typescript
export class WorkflowNotRunningError extends AppError {
  readonly code = 'WORKFLOW_NOT_RUNNING';
  readonly httpStatus = 409;
  constructor(runId: string, currentStatus: string) {
    super(`Workflow run ${runId} is not running (status: ${currentStatus})`, { runId, currentStatus });
  }
}

export class StageNotRunningError extends AppError {
  readonly code = 'STAGE_NOT_RUNNING';
  readonly httpStatus = 409;
  constructor(runId: string, stageName: string) {
    super(`Stage '${stageName}' in run ${runId} is not running`, { runId, stageName });
  }
}

export class ReviewAlreadySubmittedError extends AppError {
  readonly code = 'REVIEW_ALREADY_SUBMITTED';
  readonly httpStatus = 409;
  constructor(reviewId: string, currentStatus: string) {
    super(`Review ${reviewId} already submitted (status: ${currentStatus})`, { reviewId, currentStatus });
  }
}

export class WorkflowNotCancellableError extends AppError {
  readonly code = 'WORKFLOW_NOT_CANCELLABLE';
  readonly httpStatus = 409;
  constructor(runId: string, currentStatus: string) {
    super(`Workflow run ${runId} cannot be cancelled (status: ${currentStatus})`, { runId, currentStatus });
  }
}

export class SandboxAlreadyExistsError extends AppError {
  readonly code = 'SANDBOX_ALREADY_EXISTS';
  readonly httpStatus = 409;
  constructor(sandboxName: string) {
    super(`Sandbox '${sandboxName}' already exists`, { sandboxName });
  }
}

export class BranchAlreadyExistsError extends AppError {
  readonly code = 'BRANCH_ALREADY_EXISTS';
  readonly httpStatus = 409;
  constructor(branch: string) {
    super(`Branch '${branch}' already exists`, { branch });
  }
}
```

### 11.4 Provisioning / Infrastructure Errors (502/503)

```typescript
export class SandboxProvisionError extends AppError {
  readonly code = 'SANDBOX_PROVISION_ERROR';
  readonly httpStatus = 502;
  constructor(sandboxName: string, reason: string) {
    super(`Failed to provision sandbox '${sandboxName}': ${reason}`, { sandboxName, reason });
  }
}

export class SandboxNotFoundError extends AppError {
  readonly code = 'SANDBOX_NOT_FOUND';
  readonly httpStatus = 404;
  constructor(sandboxName: string) {
    super(`Sandbox '${sandboxName}' not found`, { sandboxName });
  }
}

export class SandboxExecError extends AppError {
  readonly code = 'SANDBOX_EXEC_ERROR';
  readonly httpStatus = 502;
  constructor(sandboxName: string, command: string, stderr: string) {
    super(`Command failed in sandbox '${sandboxName}': ${command}`, { sandboxName, command, stderr });
  }
}

export class AcpConnectionError extends AppError {
  readonly code = 'ACP_CONNECTION_ERROR';
  readonly httpStatus = 502;
  constructor(reason: string) {
    super(`ACP connection failed: ${reason}`, { reason });
  }
}

export class AcpSessionNotActiveError extends AppError {
  readonly code = 'ACP_SESSION_NOT_ACTIVE';
  readonly httpStatus = 409;
  constructor(sandboxName: string) {
    super(`No active ACP session for sandbox '${sandboxName}'`, { sandboxName });
  }
}

export class AcpConnectionNotFoundError extends AppError {
  readonly code = 'ACP_CONNECTION_NOT_FOUND';
  readonly httpStatus = 404;
  constructor(sandboxName: string) {
    super(`No ACP connection found for sandbox '${sandboxName}'`, { sandboxName });
  }
}
```

### 11.5 Git Operation Errors

```typescript
export class GitOperationError extends AppError {
  readonly code = 'GIT_OPERATION_ERROR';
  readonly httpStatus = 500;
  constructor(operation: string, stderr: string) {
    super(`Git ${operation} failed: ${stderr}`, { operation, stderr });
  }
}

export class WorktreeCreateError extends AppError {
  readonly code = 'WORKTREE_CREATE_ERROR';
  readonly httpStatus = 500;
  constructor(branch: string, stderr: string) {
    super(`Failed to create worktree for branch '${branch}': ${stderr}`, { branch, stderr });
  }
}

export class WorktreeNotReadyError extends AppError {
  readonly code = 'WORKTREE_NOT_READY';
  readonly httpStatus = 409;
  constructor(runId: string) {
    super(`Worktree not yet created for run ${runId}`, { runId });
  }
}

export class MergeError extends AppError {
  readonly code = 'MERGE_ERROR';
  readonly httpStatus = 409;
  constructor(branch: string, targetBranch: string, stderr: string) {
    super(
      `Cannot fast-forward merge '${branch}' into '${targetBranch}': ${stderr}`,
      { branch, targetBranch, stderr }
    );
  }
}

export class RebaseConflictError extends AppError {
  readonly code = 'REBASE_CONFLICT';
  readonly httpStatus = 409;
  constructor(conflictFiles: string[]) {
    super(`Rebase conflict in ${conflictFiles.length} file(s)`, { conflictFiles });
  }
}
```

### 11.6 Input Validation Errors (400)

```typescript
export class InvalidGitRefError extends AppError {
  readonly code = 'INVALID_GIT_REF';
  readonly httpStatus = 400;
  constructor(reason: string) {
    super(`Invalid git ref: ${reason}`);
  }
}

export class PathTraversalError extends AppError {
  readonly code = 'PATH_TRAVERSAL';
  readonly httpStatus = 400;
  constructor(reason: string) {
    super(`Path traversal detected: ${reason}`);
  }
}

export class ValidationError extends AppError {
  readonly code = 'VALIDATION_ERROR';
  readonly httpStatus = 400;
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details);
  }
}

export class AgentCapabilityError extends AppError {
  readonly code = 'AGENT_CAPABILITY_ERROR';
  readonly httpStatus = 400;
  constructor(agentName: string, missing: string) {
    super(`Agent '${agentName}' does not support: ${missing}`, { agentName, missing });
  }
}

export class CommandExtractError extends AppError {
  readonly code = 'COMMAND_EXTRACT_ERROR';
  readonly httpStatus = 502;
  constructor(key: string, command: string, stderr: string) {
    super(`Command extract for '${key}' failed: ${stderr}`, { key, command, stderr });
  }
}

export class CommandTimeoutError extends AppError {
  readonly code = 'COMMAND_TIMEOUT';
  readonly httpStatus = 504;
  constructor(command: string, args: string[], timeoutMs: number) {
    super(`Command '${command}' timed out after ${timeoutMs}ms`, { command, args, timeoutMs });
  }
}

export class ReviewCreateError extends AppError {
  readonly code = 'REVIEW_CREATE_ERROR';
  readonly httpStatus = 500;
  constructor(runId: string, reason: string) {
    super(`Failed to create review for run ${runId}: ${reason}`, { runId, reason });
  }
}
```

### 11.7 Error-to-HTTP-Status Mapping

```typescript
// routes/error-handler.ts

import type { Context } from 'hono';
import { AppError } from '../lib/errors.js';

/**
 * Hono error handler middleware.
 * Maps AppError subclasses to structured HTTP responses.
 */
export function errorHandler(err: Error, c: Context) {
  if (err instanceof AppError) {
    return c.json(err.toJSON(), err.httpStatus as any);
  }

  // Unexpected errors
  c.get('logger')?.error({ err }, 'Unhandled error');
  return c.json(
    {
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred',
        details: {},
      },
    },
    500
  );
}
```

---

## 12. Initialization & Dependency Injection

**File:** `index.ts` (daemon entry point)
**Pattern:** Constructor injection with a factory function per service. Services are created in DAG order during daemon startup.

```typescript
// index.ts — service initialization (sketch)

import { createSandboxService } from './services/sandbox.js';
import { createWorktreeService } from './services/worktree.js';
import { createAcpClient } from './services/acp-client.js';
import { createStreamingService } from './services/streaming-service.js';
import { createReviewService } from './services/review-service.js';
import { createCredentialVault } from './services/credential-vault.js';
import { createBranchNamer } from './services/branch-namer.js';
import { parseUnifiedDiff } from './services/diff-parser.js';
import { getOrCreateEncryptionKey } from './lib/encryption.js';
import { getDb } from './db/index.js';
import pino from 'pino';

export interface ServiceContainer {
  sandbox: SandboxService;
  worktree: WorktreeService;
  acpClient: AcpClient;
  streaming: StreamingService;
  review: ReviewService;
  credentials: CredentialVault;
  branchNamer: BranchNamer;
  diffParser: { parseUnifiedDiff: typeof parseUnifiedDiff };
}

/**
 * Initialize all services in dependency order.
 * Called once during daemon startup. The returned container
 * is passed to route handlers and workflow steps.
 */
export async function initializeServices(): Promise<ServiceContainer> {
  const logger = pino({ name: 'vibe-harness' });
  const db = await getDb();

  // --- Layer 0: No dependencies (standalone) ---

  const diffParser = { parseUnifiedDiff };

  const branchNamer = createBranchNamer({
    logger: logger.child({ service: 'branch-namer' }),
    llmCall: async (prompt) => {
      // TODO: Wire to actual LLM (Copilot API or local model)
      throw new Error('LLM not configured');
    },
  });

  const credentials = createCredentialVault({
    logger: logger.child({ service: 'credentials' }),
    db,
    getEncryptionKey: getOrCreateEncryptionKey,
  });

  const sandbox = createSandboxService({
    logger: logger.child({ service: 'sandbox' }),
  });

  const worktree = createWorktreeService({
    logger: logger.child({ service: 'worktree' }),
    diffParser,
  });

  const acpClient = createAcpClient({
    logger: logger.child({ service: 'acp-client' }),
  });

  // --- Layer 1: Depends on Layer 0 ---

  const streaming = createStreamingService({
    logger: logger.child({ service: 'streaming' }),
    acpClient,
    persistEvents: async (runId, stageName, events) => {
      // Batch insert into runMessages table
      const values = events.map((e) => ({
        id: crypto.randomUUID(),
        workflowRunId: runId,
        stageName,
        round: 1, // Set by caller context
        sessionBoundary: 0,
        role: mapAcpEventToRole(e),
        content: JSON.stringify(e.data),
        isIntervention: 0,
        metadata: JSON.stringify(e.data),
        createdAt: e.receivedAt,
      }));

      if (values.length > 0) {
        await db.insert(runMessages).values(values);
      }
    },
  });

  const review = createReviewService({
    logger: logger.child({ service: 'review' }),
    db,
    worktreeService: worktree,
    sandboxService: sandbox,
  });

  // --- Container ---

  return {
    sandbox,
    worktree,
    acpClient,
    streaming,
    review,
    credentials,
    branchNamer,
    diffParser,
  };
}

/** Map ACP event type to runMessages role column */
function mapAcpEventToRole(event: AcpEvent): string {
  switch (event.type) {
    case 'agent_message':
    case 'agent_thought':
      return 'assistant';
    case 'tool_call':
    case 'tool_result':
      return 'tool';
    case 'session_update':
    case 'result':
    case 'error':
      return 'system';
    default:
      return 'system';
  }
}
```

---

## Traceability

| Service | SAD Section(s) | SRD Requirement(s) |
|---------|---------------|-------------------|
| Sandbox | §3.3, §6.2 | FR-W17, FR-C4, NFR-R3 |
| Worktree | §5.5 | FR-W18, FR-R10, FR-S5, FR-S9, NFR-S5 |
| ACP Client | §3.3, §5.4 | FR-W4, FR-W7, FR-W20, FR-W21 |
| Streaming | §2.2.4 | FR-W19, FR-W20, NFR-P1 |
| Review | §5.3.1 | FR-R1–R9 |
| Credential Vault | §6 | FR-C1–C8 |
| Branch Namer | §5.5.2 | FR-W18, FR-S5 |
| Diff Parser | — | FR-R2, FR-R3 |
| Error Types | §10.2 | NFR-R5 (idempotency) |
| Initialization | §5.1, §2.1.2 | — |
