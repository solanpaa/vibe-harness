// ---------------------------------------------------------------------------
// Sandbox Service (CDD §3)
//
// Manages Docker sandbox lifecycle — create, exec, stop, list.
// One sandbox per workflow run, named vibe-<runId prefix>.
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

// ── Public types (CDD §3.1) ──────────────────────────────────────────

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

export interface SandboxCreateOptions {
  /** Workflow run ID — used to derive sandbox name: vibe-<first12chars> */
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

/**
 * Tracked state for a running sandbox.
 * Persisted in-memory for the lifetime of the sandbox.
 */
export interface SandboxState {
  runId: string;
  sandboxName: string;
  pid?: number;
  /**
   * Env vars from credential injection (env_var + command_extract types).
   * Persisted here so that session-manager can pass them on EVERY
   * execInteractive() / execCommand() call — not just on create().
   * Docker sandbox exec does not inherit env vars from create().
   */
  envVars: Array<{ key: string; value: string }>;
}

export interface SandboxExecOptions {
  /** Command and arguments to run inside the sandbox */
  command: string[];
  /** Environment variables to set for this exec invocation */
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
  list(): Promise<SandboxInfo[]>;
  isActive(sandboxName: string): boolean;
  getSandboxName(runId: string): string;
  reconcileFromDocker(): Promise<void>;
}

// ── Factory ──────────────────────────────────────────────────────────

export function createSandboxService(deps: {
  logger: Logger;
}): SandboxService {
  const { logger } = deps;

  /**
   * In-memory map of active sandboxes.
   * Rebuilt from Docker state on daemon restart via reconcileFromDocker().
   */
  const activeSandboxes = new Map<string, SandboxState>();

  /** Per-sandbox-name mutex to prevent getOrCreate race conditions */
  const createLocks = new Map<string, Mutex>();

  // ── Helpers ──────────────────────────────────────────────────────

  function getSandboxName(runId: string): string {
    return `vibe-${runId.slice(0, 12)}`;
  }

  /** Build -e KEY=VALUE args from SandboxState.envVars + caller overrides */
  function buildEnvArgs(
    sandboxName: string,
    extraEnv?: Record<string, string>,
  ): string[] {
    const state = activeSandboxes.get(sandboxName);
    const allEnv: Record<string, string> = {};

    // Persisted env vars from credential injection (base layer)
    if (state) {
      for (const { key, value } of state.envVars) {
        allEnv[key] = value;
      }
    }

    // Caller-provided env vars (override layer)
    if (extraEnv) {
      Object.assign(allEnv, extraEnv);
    }

    return Object.entries(allEnv).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  }

  function buildHostDirMountArgs(
    mounts: Array<{ hostPath: string; containerPath: string }>,
  ): string[] {
    return mounts.flatMap((m) => ['-v', `${m.hostPath}:${m.containerPath}:ro`]);
  }

  function assertSandboxExists(sandboxName: string): void {
    if (!activeSandboxes.has(sandboxName)) {
      throw new SandboxNotFoundError(sandboxName);
    }
  }

  // ── Network proxy configuration ─────────────────────────────────

  async function configureNetworkProxy(
    sandboxName: string,
    policy: NetworkPolicy,
    allowlist?: string[],
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
        `Network proxy setup failed: ${result.stderr}`,
      );
    }
  }

  // ── Credential injection ────────────────────────────────────────

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
    log: Logger,
  ): Promise<void> {
    // File mounts: pipe content to tee inside sandbox
    for (const mount of creds.fileMounts) {
      log.debug({ mountPath: mount.mountPath }, 'Injecting file mount');

      // Ensure parent directory exists
      const parentDir = mount.mountPath.split('/').slice(0, -1).join('/');
      if (parentDir) {
        await execCommand('docker', [
          'sandbox', 'exec', sandboxName,
          'mkdir', '-p', parentDir,
        ]);
      }

      // Pipe content via stdin → tee
      const child = spawn('docker', [
        'sandbox', 'exec', '-i', sandboxName,
        'tee', mount.mountPath,
      ], { stdio: ['pipe', 'pipe', 'pipe'] });

      await new Promise<void>((resolve, reject) => {
        child.on('close', (code) =>
          code === 0
            ? resolve()
            : reject(
                new SandboxExecError(
                  sandboxName,
                  `tee ${mount.mountPath}`,
                  code ?? 1,
                  '',
                ),
              ),
        );
        child.on('error', reject);
        child.stdin!.end(mount.content);
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
      throw new SandboxAlreadyExistsError(sandboxName);
    }

    // Step 1: Create sandbox (mount worktree as /workspace)
    log.info('Creating Docker sandbox');
    const createResult = await execCommand('docker', [
      'sandbox', 'create',
      '--name', sandboxName,
      '--image', options.image,
      '-v', `${options.workdir}:/workspace`,
      ...buildHostDirMountArgs(options.credentials?.hostDirMounts ?? []),
    ]);

    if (createResult.exitCode !== 0) {
      throw new SandboxProvisionError(
        sandboxName,
        `docker sandbox create failed: ${createResult.stderr}`,
      );
    }

    // Step 2: Configure network proxy (SAD §6.2)
    await configureNetworkProxy(
      sandboxName,
      options.networkPolicy,
      options.networkAllowlist,
    );

    // Step 3: Inject credentials (must happen before ACP session starts)
    if (options.credentials) {
      await injectCredentials(sandboxName, options.credentials, log);
    }

    // Step 4: Register sandbox with persisted env vars
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

      // 2. Exists in Docker (e.g., after daemon restart + workflow replay)
      const liveSandboxes = await listSandboxes();
      const existing = liveSandboxes.find((s) => s.name === sandboxName);
      if (existing && existing.status === 'running') {
        log.info('Sandbox found in Docker (reconciliation), populating state');
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

    const envArgs = buildEnvArgs(sandboxName, options.env);
    const workdirArgs = options.workdir ? ['-w', options.workdir] : [];

    const child = spawn('docker', [
      'sandbox', 'exec',
      '-i',
      ...envArgs,
      ...workdirArgs,
      sandboxName,
      ...options.command,
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

    const envArgs = buildEnvArgs(sandboxName, options.env);
    const workdirArgs = options.workdir ? ['-w', options.workdir] : [];

    const result = await execCommand('docker', [
      'sandbox', 'exec',
      ...envArgs,
      ...workdirArgs,
      sandboxName,
      ...options.command,
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
      'docker',
      ['sandbox', 'stop', sandboxName],
      { timeout: forceKillTimeout },
    );

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
        // Sandbox exists in Docker but not tracked — add to map.
        // runId is extracted from the sandbox name (vibe-<runIdPrefix>).
        //
        // NOTE: envVars will be empty for reconciled sandboxes because
        // credential values cannot be recovered from Docker state.
        // When a workflow replays via getOrCreate(), the caller must
        // re-supply credentials in the SandboxCreateOptions so that
        // envVars are populated for subsequent exec calls.
        const runIdPrefix = info.name.replace('vibe-', '');
        activeSandboxes.set(info.name, {
          runId: runIdPrefix,
          sandboxName: info.name,
          envVars: [],
        });
        log.info({ sandboxName: info.name }, 'Reconciled sandbox from Docker');
      }
    }
  }

  // ── Public interface ────────────────────────────────────────────

  return {
    create,
    getOrCreate,
    execInteractive: sandboxExecInteractive,
    execCommand: sandboxExecCommand,
    getEnvVars,
    stop,
    list: listSandboxes,
    isActive: (name) => activeSandboxes.has(name),
    getSandboxName,
    reconcileFromDocker,
  };
}
