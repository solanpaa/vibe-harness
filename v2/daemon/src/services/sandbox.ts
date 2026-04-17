// ---------------------------------------------------------------------------
// Sandbox Service (CDD §3)
//
// Manages sbx (Docker AI Sandboxes) lifecycle — create, exec, stop, list.
// One sandbox per workflow run, named vibe-<runId prefix>.
//
// CLI: https://docs.docker.com/ai/sandboxes/
//   sbx create [--name N] [--template IMG] [--memory M] [--cpus N] AGENT WORKSPACE [WORKSPACE...]
//   sbx exec [--workdir W] NAME -- CMD ...
//   sbx stop NAME
//   sbx rm NAME
//   sbx ls --format json
//
// Custom env vars (`/etc/sandbox-persistent.sh`):
//   sbx supports per-supported-service credentials via `sbx secret` + a host-side
//   proxy. For *custom* env vars (not bound to a known service), the documented
//   pattern is to append `export KEY=VAL` to `/etc/sandbox-persistent.sh` inside
//   the sandbox; this file is sourced on every shell login. Subsequent execs
//   must run inside `bash -lc` for the file to be sourced.
// ---------------------------------------------------------------------------

import { spawn, type ChildProcess } from 'node:child_process';
import type { Logger } from 'pino';
import { Mutex } from '../lib/mutex.js';
import { execCommand, type ExecResult } from '../lib/shell.js';
import {
  SandboxProvisionError,
  SandboxAlreadyExistsError,
  SandboxNotFoundError,
  SandboxExecError,
} from '../lib/errors.js';

// ── Public types ─────────────────────────────────────────────────────

export interface SandboxCredentials {
  /** KEY=VALUE pairs to inject as persistent env vars inside the sandbox */
  envVars: Array<{ key: string; value: string }>;
  /** Read-only host-file bind mounts — passed as extra workspaces with :ro */
  fileMounts: Array<{ hostPath: string; containerPath: string }>;
  /** Docker registry login commands to run inside sandbox */
  dockerLogins: Array<{ registry: string; username: string; password: string }>;
  /** Read-only host directory bind mounts — passed as extra workspaces with :ro */
  hostDirMounts: Array<{ hostPath: string; containerPath: string }>;
}

export interface SandboxCreateOptions {
  /** Workflow run ID — used to derive sandbox name: vibe-<first12chars> */
  runId: string;
  /** Container image to use as template (from agent definition). Optional — agent default used if not set. */
  image?: string;
  /** Host path to mount as the working directory (worktree path) */
  workdir: string;
  /** Additional host paths to mount inside the sandbox (e.g. project .git dir for worktree refs) */
  extraWorkspaces?: string[];
  /** sbx agent subcommand (e.g. 'copilot', 'claude', 'codex') */
  agentSubcommand?: string;
  /** Credential injection args built by CredentialVault.buildSandboxCredentials() */
  credentials?: SandboxCredentials;
  /** Optional sbx --memory flag value (e.g. "8g", "1024m"). Omitted if undefined. */
  memory?: string;
  /** Optional sbx --cpus flag value (0 = sbx auto). Omitted if undefined. */
  cpus?: number;
}

/**
 * Tracked state for a running sandbox.
 *
 * envVars are persisted in-memory so that callers can re-inject after a daemon
 * restart if needed. The sbx implementation also writes them to
 * `/etc/sandbox-persistent.sh` inside the sandbox so they survive across exec
 * invocations and daemon restarts.
 */
export interface SandboxState {
  runId: string;
  sandboxName: string;
  pid?: number;
  envVars: Array<{ key: string; value: string }>;
}

export interface SandboxExecOptions {
  /** Command and arguments to run inside the sandbox */
  command: string[];
  /** Environment variables to set for this exec invocation only (in addition to persistent ones) */
  env?: Record<string, string>;
  /** Working directory inside the sandbox */
  workdir?: string;
  /** When true, throw SandboxExecError if exit code is non-zero */
  expectZero?: boolean;
}

export interface SandboxProcess {
  /** Node.js ChildProcess for stdio access */
  process: ChildProcess;
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
  create(options: SandboxCreateOptions): Promise<string>;
  getOrCreate(options: SandboxCreateOptions): Promise<string>;
  execInteractive(
    sandboxName: string,
    options: SandboxExecOptions,
  ): Promise<SandboxProcess>;
  execCommand(
    sandboxName: string,
    options: SandboxExecOptions,
  ): Promise<ExecResult>;
  getEnvVars(sandboxName: string): Record<string, string>;
  stop(sandboxName: string, forceKillTimeout?: number): Promise<void>;
  /** Remove a sandbox entirely (sbx rm). */
  remove(sandboxName: string): Promise<void>;
  /** Stop a sandbox by name regardless of active tracking (for reconciliation/shutdown). */
  forceStop(sandboxName: string): Promise<void>;
  list(): Promise<SandboxInfo[]>;
  isActive(sandboxName: string): boolean;
  getSandboxName(runId: string): string;
  reconcileFromDocker(): Promise<void>;
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Posix-shell-quote a single argument so it survives `bash -lc`.
 * Single-quotes the value and escapes embedded single quotes.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Build a `bash -lc` argv that:
 *   1. exports caller-supplied per-exec env vars (persistent ones are sourced
 *      automatically from /etc/sandbox-persistent.sh by the login shell)
 *   2. execs the requested command via `exec` so signals and exit codes pass through
 */
function buildLoginShellCommand(
  command: string[],
  extraEnv?: Record<string, string>,
): string[] {
  const exports = extraEnv
    ? Object.entries(extraEnv)
        .map(([k, v]) => `export ${k}=${shellQuote(v)}`)
        .join('; ')
    : '';
  const exec = `exec ${command.map(shellQuote).join(' ')}`;
  const script = exports ? `${exports}; ${exec}` : exec;
  return ['bash', '-lc', script];
}

/**
 * Format a single workspace argument for `sbx create`:
 * either "/path/to/dir" or "/path/to/dir:ro".
 */
function formatWorkspace(path: string, readOnly = false): string {
  return readOnly ? `${path}:ro` : path;
}

// ── Factory ──────────────────────────────────────────────────────────

export function createSandboxService(deps: {
  logger: Logger;
}): SandboxService {
  const { logger } = deps;

  /**
   * In-memory map of active sandboxes.
   * Rebuilt from sbx state on daemon restart via reconcileFromDocker().
   */
  const activeSandboxes = new Map<string, SandboxState>();

  /** Per-sandbox-name mutex to prevent getOrCreate race conditions */
  const createLocks = new Map<string, Mutex>();

  // ── Helpers ──────────────────────────────────────────────────────

  function getSandboxName(runId: string): string {
    return `vibe-${runId.slice(0, 12)}`;
  }

  function assertSandboxExists(sandboxName: string): void {
    if (!activeSandboxes.has(sandboxName)) {
      throw new SandboxNotFoundError(sandboxName);
    }
  }

  // ── Credential injection (persistent env file) ───────────────────

  /**
   * Inject credentials into a freshly-created sandbox. (SAD §6.2, SRD FR-C4)
   *
   * Order:
   *   1. Append env vars to /etc/sandbox-persistent.sh (sourced on every shell login)
   *   2. Run docker logins inside sandbox
   *
   * file_mount and host_dir_mount entries are passed as `--workspace path:ro` at
   * create time (see formatWorkspace); they are not handled here.
   */
  async function injectCredentials(
    sandboxName: string,
    creds: SandboxCredentials,
    log: Logger,
  ): Promise<void> {
    // 1. Persistent env vars
    if (creds.envVars.length > 0) {
      const exportLines = creds.envVars
        .map(({ key, value }) => `export ${key}=${shellQuote(value)}`)
        .join('\n');
      const script = `cat >> /etc/sandbox-persistent.sh <<'__VIBE_EOF__'\n${exportLines}\n__VIBE_EOF__`;
      log.debug({ envKeyCount: creds.envVars.length }, 'Writing persistent env vars');
      const result = await execCommand('sbx', [
        'exec', sandboxName,
        'bash', '-lc', script,
      ]);
      if (result.exitCode !== 0) {
        throw new SandboxExecError(
          sandboxName,
          'persistent env var injection',
          result.exitCode,
          result.stderr,
        );
      }
    }

    // 2. Docker logins (use docker CLI inside sandbox)
    for (const login of creds.dockerLogins) {
      log.debug({ registry: login.registry }, 'Injecting Docker login');
      const child = spawn('sbx', [
        'exec', sandboxName,
        'docker', 'login', login.registry,
        '--username', login.username,
        '--password-stdin',
      ], { stdio: ['pipe', 'pipe', 'pipe'] });

      await new Promise<void>((resolve, reject) => {
        child.on('close', (code) =>
          code === 0
            ? resolve()
            : reject(
                new SandboxExecError(
                  sandboxName,
                  `docker login ${login.registry}`,
                  code ?? 1,
                  '',
                ),
              ),
        );
        child.on('error', reject);
        child.stdin!.end(login.password);
      });
    }
  }

  // ── Core operations ─────────────────────────────────────────────

  async function create(options: SandboxCreateOptions): Promise<string> {
    const sandboxName = getSandboxName(options.runId);
    const log = logger.child({ sandboxName, runId: options.runId });

    if (activeSandboxes.has(sandboxName)) {
      log.info('Sandbox already tracked, reusing');
      return sandboxName;
    }

    // Step 1: sbx create
    // sbx create [flags] AGENT PATH [PATH...]
    const agentSubcommand = options.agentSubcommand ?? 'copilot';

    // Build extra workspaces. Includes:
    //   - explicit extraWorkspaces from caller (e.g. parent .git dir)
    //   - read-only host-dir mounts from credentials (file_mount + host_dir_mount)
    const extraWorkspaces = [...(options.extraWorkspaces ?? [])];
    if (options.credentials) {
      for (const m of options.credentials.fileMounts) {
        extraWorkspaces.push(formatWorkspace(m.hostPath, true));
      }
      for (const m of options.credentials.hostDirMounts) {
        extraWorkspaces.push(formatWorkspace(m.hostPath, true));
      }
    }

    log.info(
      {
        agentSubcommand,
        workdir: options.workdir,
        image: options.image,
        memory: options.memory,
        cpus: options.cpus,
      },
      'Creating sbx sandbox',
    );
    const createArgs = [
      'create',
      '--name', sandboxName,
      ...(options.image ? ['--template', options.image] : []),
      ...(options.memory ? ['--memory', options.memory] : []),
      ...(options.cpus !== undefined ? ['--cpus', String(options.cpus)] : []),
      agentSubcommand,
      options.workdir,
      ...extraWorkspaces,
    ];
    log.debug({ cmd: ['sbx', ...createArgs] }, 'Full sbx create command');

    const createResult = await execCommand('sbx', createArgs, { timeout: 360_000 });
    log.debug(
      { exitCode: createResult.exitCode, stdout: createResult.stdout.slice(0, 300), stderr: createResult.stderr.slice(0, 300) },
      'sbx create result',
    );

    if (createResult.exitCode !== 0) {
      // Idempotent: if sandbox already exists (e.g. step retry), proceed
      if (createResult.stderr.includes('already exists')) {
        log.info('Sandbox already exists, reusing');
      } else {
        throw new SandboxProvisionError(
          sandboxName,
          `sbx create failed: ${createResult.stderr}`,
        );
      }
    }

    // Step 2: Inject credentials (must happen before ACP session starts)
    if (options.credentials) {
      const credSummary = {
        envVarCount: options.credentials.envVars.length,
        envVarKeys: options.credentials.envVars.map(e => e.key),
        fileMountCount: options.credentials.fileMounts.length,
        fileMountPaths: options.credentials.fileMounts.map(f => f.hostPath),
        dockerLoginCount: options.credentials.dockerLogins.length,
        dockerLoginRegistries: options.credentials.dockerLogins.map(l => l.registry),
        hostDirMountCount: options.credentials.hostDirMounts.length,
      };
      log.info(credSummary, 'Injecting credentials');
      await injectCredentials(sandboxName, options.credentials, log);
      log.info('Credentials injected');
    }

    // Step 3: Register sandbox
    const envVars = options.credentials?.envVars ?? [];
    activeSandboxes.set(sandboxName, {
      runId: options.runId,
      sandboxName,
      envVars,
    });

    log.info('Sandbox created successfully');
    return sandboxName;
  }

  async function getOrCreate(options: SandboxCreateOptions): Promise<string> {
    const sandboxName = getSandboxName(options.runId);

    // Acquire per-sandbox-name mutex to prevent concurrent creates
    const lock = createLocks.get(sandboxName) ?? new Mutex();
    createLocks.set(sandboxName, lock);

    return lock.runExclusive(async () => {
      const log = logger.child({ sandboxName, runId: options.runId });

      // 1. Already tracked in memory
      if (activeSandboxes.has(sandboxName)) {
        log.debug('Sandbox already active (in-memory), reusing');
        return sandboxName;
      }

      // 2. Exists in sbx (e.g., after daemon restart + workflow replay)
      const liveSandboxes = await listSandboxes();
      const existing = liveSandboxes.find((s) => s.name === sandboxName);
      if (existing && existing.status === 'running') {
        log.info('Sandbox found in sbx (reconciliation), populating state');
        const envVars = options.credentials?.envVars ?? [];
        activeSandboxes.set(sandboxName, {
          runId: options.runId,
          sandboxName,
          envVars,
        });
        return sandboxName;
      }

      // 3. Does not exist — create fresh
      try {
        return await create(options);
      } catch (err) {
        // Another process may have created it between our check and create
        if (err instanceof SandboxAlreadyExistsError) {
          log.info('Sandbox was created concurrently, reusing');
          return sandboxName;
        }
        throw err;
      }
    });
  }

  async function sandboxExecInteractive(
    sandboxName: string,
    options: SandboxExecOptions,
  ): Promise<SandboxProcess> {
    assertSandboxExists(sandboxName);

    const workdirArgs = options.workdir ? ['--workdir', options.workdir] : [];
    const shellCmd = buildLoginShellCommand(options.command, options.env);

    const child = spawn('sbx', [
      'exec',
      ...workdirArgs,
      sandboxName,
      ...shellCmd,
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    return { process: child, sandboxName };
  }

  async function sandboxExecCommand(
    sandboxName: string,
    options: SandboxExecOptions,
  ): Promise<ExecResult> {
    assertSandboxExists(sandboxName);

    const workdirArgs = options.workdir ? ['--workdir', options.workdir] : [];
    const shellCmd = buildLoginShellCommand(options.command, options.env);

    const result = await execCommand('sbx', [
      'exec',
      ...workdirArgs,
      sandboxName,
      ...shellCmd,
    ]);

    if (options.expectZero && result.exitCode !== 0) {
      throw new SandboxExecError(
        sandboxName,
        options.command.join(' '),
        result.exitCode,
        result.stderr,
      );
    }

    return result;
  }

  function getEnvVars(sandboxName: string): Record<string, string> {
    const state = activeSandboxes.get(sandboxName);
    if (!state) return {};
    return Object.fromEntries(
      state.envVars.map(({ key, value }) => [key, value]),
    );
  }

  async function stop(
    sandboxName: string,
    forceKillTimeout = 10_000,
  ): Promise<void> {
    if (!activeSandboxes.has(sandboxName)) {
      return; // already stopped or never tracked
    }

    const log = logger.child({ sandboxName });

    log.info('Stopping sandbox');
    const stopResult = await execCommand(
      'sbx',
      ['stop', sandboxName],
      { timeout: forceKillTimeout },
    );

    if (stopResult.exitCode !== 0) {
      log.warn({ stderr: stopResult.stderr }, 'Graceful stop failed, force removing');
      const rmArgs = ['rm', sandboxName];
      log.debug({ cmd: ['sbx', ...rmArgs] }, 'Running sbx rm');
      await execCommand('sbx', rmArgs);
    }

    activeSandboxes.delete(sandboxName);
    log.info('Sandbox stopped');
  }

  async function remove(sandboxName: string): Promise<void> {
    const log = logger.child({ sandboxName });
    log.info('Removing sandbox');
    try {
      await execCommand('sbx', ['rm', sandboxName]);
      log.info('Sandbox removed');
    } catch (err) {
      log.warn({ err }, 'sbx rm failed (may already be removed)');
    }
    activeSandboxes.delete(sandboxName);
  }

  /**
   * List all vibe-prefixed sandboxes via `sbx ls --format json`.
   *
   * sbx ls --format json emits one JSON object per line (NDJSON). Field names
   * are normalized below to the SandboxInfo shape; sbx may use slightly
   * different field names (e.g. `Name`, `Status`, `Workspace`, `Image`) — we
   * accept either casing for resilience.
   */
  async function listSandboxes(): Promise<SandboxInfo[]> {
    const result = await execCommand('sbx', ['ls', '--format', 'json']);

    if (result.exitCode !== 0 || !result.stdout.trim()) {
      return [];
    }

    const items: SandboxInfo[] = [];
    for (const line of result.stdout.trim().split('\n')) {
      if (!line.trim()) continue;
      try {
        const raw = JSON.parse(line) as Record<string, unknown>;
        const name = String(raw.name ?? raw.Name ?? '');
        if (!name.startsWith('vibe-')) continue;
        const statusRaw = String(raw.status ?? raw.Status ?? 'unknown').toLowerCase();
        const status: SandboxInfo['status'] =
          statusRaw === 'running' || statusRaw === 'stopped' ? statusRaw : 'unknown';
        items.push({
          name,
          status,
          image: String(raw.image ?? raw.Image ?? raw.template ?? raw.Template ?? ''),
          created: String(raw.created ?? raw.Created ?? raw.createdAt ?? ''),
        });
      } catch {
        // Skip malformed lines
      }
    }
    return items;
  }

  async function reconcileFromDocker(): Promise<void> {
    const log = logger.child({ operation: 'reconcile' });
    const liveSandboxes = await listSandboxes();

    for (const info of liveSandboxes) {
      // Only adopt running sandboxes — stopped/unknown ones are stale
      if (info.status !== 'running') {
        log.debug({ sandboxName: info.name, status: info.status }, 'Skipping non-running sandbox');
        continue;
      }

      if (!activeSandboxes.has(info.name)) {
        // Sandbox exists in sbx but not tracked — add to map.
        // runId is extracted from the sandbox name (vibe-<runIdPrefix>).
        //
        // NOTE: envVars will be empty in the in-memory state for reconciled
        // sandboxes — but the actual env vars are still live inside the
        // sandbox via /etc/sandbox-persistent.sh, so subsequent `sbx exec`
        // invocations (which run via `bash -lc`) will see them automatically.
        const runIdPrefix = info.name.replace('vibe-', '');
        activeSandboxes.set(info.name, {
          runId: runIdPrefix,
          sandboxName: info.name,
          envVars: [],
        });
        log.info({ sandboxName: info.name }, 'Reconciled sandbox from sbx');
      }
    }
  }

  /** Stop a sandbox by name, bypassing active-map check (reconciliation/shutdown). */
  async function forceStop(sandboxName: string): Promise<void> {
    const log = logger.child({ sandboxName });
    log.info('Force-stopping sandbox');

    const stopResult = await execCommand(
      'sbx',
      ['stop', sandboxName],
      { timeout: 15_000 },
    );

    if (stopResult.exitCode !== 0) {
      log.warn({ stderr: stopResult.stderr }, 'Graceful stop failed, force removing');
      const rmArgs = ['rm', sandboxName];
      log.debug({ cmd: ['sbx', ...rmArgs] }, 'Running sbx rm (force)');
      await execCommand('sbx', rmArgs);
    }

    activeSandboxes.delete(sandboxName);
    log.info('Sandbox force-stopped');
  }

  // ── Public interface ────────────────────────────────────────────

  return {
    create,
    getOrCreate,
    execInteractive: sandboxExecInteractive,
    execCommand: sandboxExecCommand,
    getEnvVars,
    stop,
    remove,
    forceStop,
    list: listSandboxes,
    isActive: (name) => activeSandboxes.has(name),
    getSandboxName,
    reconcileFromDocker,
  };
}
