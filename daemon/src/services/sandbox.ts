// ---------------------------------------------------------------------------
// Sandbox Service — microsandbox backend.
//
// Manages microsandbox microVM lifecycle — create, exec, stop, list. One
// sandbox per workflow run, named `vibe-<runId prefix>`.
//
// SDK: https://github.com/superradcompany/microsandbox (TypeScript: `microsandbox`)
//
// Responsibilities (CDD §3):
//   - Build a Sandbox via `Sandbox.builder(name).image(...).cpus().memory()
//     .env(K,V).volume(guest, b => b.bind(host)).network(n => n.policyJson(...))
//     .create()`
//   - Inject credentials as native env vars + read-only volume binds
//     (no /etc/sandbox-persistent.sh, no symlink remap)
//   - Wrap `Sandbox.execStream(...)` (which returns an `ExecHandle` —
//     `AsyncIterable<ExecEvent>`) into Node-friendly Web streams for the ACP
//     client's `acp.ndJsonStream(writable, readable)` consumer.
//   - Stop / drain / kill via SDK terminals.
//
// Reboot survival (deliberate non-goal): sandboxes are created in *attached*
// mode (`.create()`), so they die with the daemon. No reconcile-from-runtime
// is needed; `index.ts` already marks active runs as failed on shutdown.
// ---------------------------------------------------------------------------

import { Readable, Writable } from 'node:stream';
import type { Logger } from 'pino';
import {
  Sandbox,
  type ExecHandle,
  type ExecSink,
  SandboxNotFoundError as MsbSandboxNotFoundError,
} from 'microsandbox';

import { Mutex } from '../lib/mutex.js';
import { assertValidEnvVarKey } from '../lib/validation/shared.js';
import {
  buildNetworkPolicy,
  type NetworkPolicyConfig,
  type DnsConfig,
} from '../lib/network-policy.js';
import type { LocalRegistry } from './local-registry.js';
import {
  SandboxProvisionError,
  SandboxAlreadyExistsError,
  SandboxNotFoundError,
  SandboxExecError,
} from '../lib/errors.js';

// ── Public types ─────────────────────────────────────────────────────

export interface SandboxCredentials {
  /** KEY=VALUE pairs to inject as env vars inside the sandbox */
  envVars: Array<{ key: string; value: string }>;
  /** Read-only host-file bind mounts. containerPath is the guest path. */
  fileMounts: Array<{ hostPath: string; containerPath: string }>;
  /** Docker registry login commands to run inside sandbox */
  dockerLogins: Array<{ registry: string; username: string; password: string }>;
  /** Read-only host directory bind mounts. containerPath is the guest path. */
  hostDirMounts: Array<{ hostPath: string; containerPath: string }>;
}

export interface SandboxNetworkConfig extends NetworkPolicyConfig, DnsConfig {
  /** Set the runtime to trust additional CA certificates from the host. */
  trustHostCas?: boolean;
}

export interface SandboxCreateOptions {
  /** Workflow run ID — used to derive sandbox name: vibe-<first12chars> */
  runId: string;
  /** Container image reference (must be available to the microsandbox runtime). */
  image?: string;
  /** Host path to mount as the working directory (worktree path). */
  workdir: string;
  /** Additional host paths to mount inside the sandbox at the same absolute path. */
  extraWorkspaces?: string[];
  /** Reserved for future agent dispatch — currently unused (microsandbox boots
   *  the image's default entrypoint and we always exec our own command). */
  agentSubcommand?: string;
  /** Credential injection bundle from CredentialVault.buildSandboxCredentials(). */
  credentials?: SandboxCredentials;
  /** Memory limit in MiB. Accepts e.g. "8g", "1024m", "1024M", "8G", or a number (MiB). */
  memory?: string | number;
  /** CPU count. Omit or 0 to use SDK default. */
  cpus?: number;
  /** Optional per-run network policy / DNS / TLS overrides. */
  network?: SandboxNetworkConfig;
}

export interface SandboxState {
  runId: string;
  sandboxName: string;
  envVars: Array<{ key: string; value: string }>;
  /** SDK handle (held while the daemon owns the sandbox lifecycle). */
  sandbox: Sandbox;
}

export interface SandboxExecOptions {
  /** Command and arguments to run inside the sandbox. */
  command: string[];
  /** Per-exec env vars (in addition to those baked into the sandbox). */
  env?: Record<string, string>;
  /** Working directory inside the sandbox. */
  workdir?: string;
  /** When true, throw SandboxExecError if exit code is non-zero. */
  expectZero?: boolean;
}

/**
 * A live interactive process inside a sandbox.
 *
 * Replaces the previous Node `ChildProcess` shape with a thin wrapper that
 * exposes Web streams (consumed by the ACP NDJSON parser) and a Promise that
 * resolves with the process exit code. The shape intentionally mirrors a few
 * of `ChildProcess`'s ergonomic affordances (`.kill()`, `.killed`, `.pid`,
 * `.on('close', ...)`) so existing call-sites need only minor changes.
 */
export interface SandboxProcess {
  sandboxName: string;
  /** Web-streams view of stdout — bytes from the guest process. */
  stdout: ReadableStream<Uint8Array>;
  /** Web-streams view of stdin — write to send bytes to the guest process. */
  stdin: WritableStream<Uint8Array>;
  /** Subscribe to stderr lines (already utf-8 decoded). */
  onStderr(handler: (chunk: string) => void): () => void;
  /** Subscribe to the close event. Fires exactly once. */
  on(event: 'close' | 'exit', handler: (exitCode: number | null) => void): void;
  /** Promise that resolves with the exit code when the process exits. */
  exit: Promise<number>;
  /** Send SIGTERM (default) or SIGKILL. Idempotent. */
  kill(signal?: 'SIGTERM' | 'SIGKILL'): Promise<void>;
  /** True once the process has exited or been killed. */
  readonly killed: boolean;
  /** PID inside the guest, available after the first stdout/stderr event. */
  readonly pid: number | undefined;
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
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  getEnvVars(sandboxName: string): Record<string, string>;
  stop(sandboxName: string, forceKillTimeout?: number): Promise<void>;
  remove(sandboxName: string): Promise<void>;
  forceStop(sandboxName: string): Promise<void>;
  list(): Promise<SandboxInfo[]>;
  isActive(sandboxName: string): boolean;
  getSandboxName(runId: string): string;
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Posix-shell-quote a single argument.
 * Single-quotes the value and escapes embedded single quotes.
 *
 * Exported because acp-client.ts and other consumers used to import it from
 * the legacy sbx implementation.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Convert "8g"|"1024m"|"1024" → MiB for the SDK's `.memory(mib: number)`. */
function memoryToMiB(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number') return value > 0 ? value : undefined;
  const m = /^([1-9]\d*)([mMgG]?)$/.exec(value.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  if (unit === 'g') return n * 1024;
  return n; // 'm' or omitted → MiB
}

// ── ExecHandle <-> Web stream bridge (T-10, highest-risk subtask) ────

/**
 * Bridge a microsandbox `ExecHandle` to the SandboxProcess shape used by the
 * rest of the daemon. The handle exposes:
 *   - an async iterator of `ExecEvent { kind: 'started'|'stdout'|'stderr'|'exited' }`
 *   - a `takeStdin()` -> `ExecSink` for writing to the guest process stdin
 *   - `kill()` / `signal(n)` for sending SIGKILL / arbitrary signals
 *
 * The bridge:
 *   - exposes stdout as a Web ReadableStream<Uint8Array> by enqueueing every
 *     `stdout` event's data (and closing on `exited`)
 *   - exposes stdin as a Web WritableStream<Uint8Array> backed by the ExecSink
 *   - dispatches `stderr` events to subscribers as decoded strings
 *   - tracks pid (from the `started` event) and exit code (from `exited`)
 */
async function bridgeExecHandle(
  handle: ExecHandle,
  sandboxName: string,
  log: Logger,
): Promise<SandboxProcess> {
  let pid: number | undefined;
  let killed = false;
  let exitCodeResolved = false;
  const stderrSubscribers = new Set<(chunk: string) => void>();
  const closeSubscribers = new Set<(code: number | null) => void>();
  const decoder = new TextDecoder();

  let resolveExit: (code: number) => void = () => {};
  const exitPromise = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });

  type StdoutController = ReadableStreamDefaultController<Uint8Array>;
  const stdoutControllerRef: { current: StdoutController | null } = { current: null };
  const stdout = new ReadableStream<Uint8Array>({
    start(controller: StdoutController) {
      stdoutControllerRef.current = controller;
    },
    cancel() {
      // Best-effort: kill the process when the consumer cancels.
      void handle.kill().catch(() => { /* ignore */ });
    },
  });

  // Async loop: forward exec events to the appropriate sink.
  void (async () => {
    try {
      for await (const event of handle) {
        // Defensive: the SDK's `normalizeExecEvent()` returns `undefined` if
        // the native binding yields an unrecognised event type. Skip rather
        // than crash the loop, but make sure we still resolve the exit
        // promise when the iterator ends.
        if (!event) continue;
        switch (event.kind) {
          case 'started':
            pid = event.pid;
            log.debug({ sandboxName, pid }, 'exec started');
            break;
          case 'stdout':
            try {
              stdoutControllerRef.current?.enqueue(new Uint8Array(event.data));
            } catch (err) {
              log.debug({ err }, 'stdout enqueue failed (consumer likely closed stream)');
            }
            break;
          case 'stderr': {
            const text = decoder.decode(event.data, { stream: true });
            for (const sub of stderrSubscribers) {
              try { sub(text); } catch { /* ignore subscriber errors */ }
            }
            break;
          }
          case 'exited': {
            exitCodeResolved = true;
            const code = event.code;
            try { stdoutControllerRef.current?.close(); } catch { /* idempotent */ }
            resolveExit(code);
            for (const sub of closeSubscribers) {
              try { sub(code); } catch { /* ignore */ }
            }
            log.debug({ sandboxName, exitCode: code }, 'exec exited');
            return;
          }
        }
      }
      // Iterator ended without an `exited` event. Fall back to the SDK's
      // `wait()` to surface the exit code so the bridge doesn't hang.
      if (!exitCodeResolved) {
        try {
          const status = await handle.wait();
          exitCodeResolved = true;
          try { stdoutControllerRef.current?.close(); } catch { /* idempotent */ }
          resolveExit(status.code);
          for (const sub of closeSubscribers) {
            try { sub(status.code); } catch { /* ignore */ }
          }
          log.debug({ sandboxName, exitCode: status.code }, 'exec exited (via wait fallback)');
        } catch (err) {
          log.warn({ err, sandboxName }, 'exec wait fallback failed; synthesising exit code 1');
          exitCodeResolved = true;
          try { stdoutControllerRef.current?.close(); } catch { /* idempotent */ }
          resolveExit(1);
          for (const sub of closeSubscribers) {
            try { sub(1); } catch { /* ignore */ }
          }
        }
      }
    } catch (err) {
      // Stream errored before exit — terminate and surface a synthetic exit code.
      log.warn({ err, sandboxName }, 'exec event stream errored');
      try { stdoutControllerRef.current?.error(err); } catch { /* idempotent */ }
      if (!exitCodeResolved) {
        exitCodeResolved = true;
        resolveExit(1);
        for (const sub of closeSubscribers) {
          try { sub(1); } catch { /* ignore */ }
        }
      }
    }
  })();

  // Stdin: take the sink lazily but eagerly enough to support write-on-create.
  const sinkPromise: Promise<ExecSink | null> = handle.takeStdin();
  const stdin = new WritableStream<Uint8Array>({
    async write(chunk) {
      const sink = await sinkPromise;
      if (!sink) throw new Error('stdin sink unavailable');
      // ExecSink.write accepts Buffer/Uint8Array via napi.
      await sink.write(chunk);
    },
    async close() {
      const sink = await sinkPromise;
      if (sink) {
        try { await sink.close(); } catch { /* idempotent */ }
      }
    },
    async abort() {
      const sink = await sinkPromise;
      if (sink) {
        try { await sink.close(); } catch { /* ignore */ }
      }
    },
  });

  const proc: SandboxProcess = {
    sandboxName,
    stdout,
    stdin,
    onStderr(handler) {
      stderrSubscribers.add(handler);
      return () => { stderrSubscribers.delete(handler); };
    },
    on(_event, handler) {
      closeSubscribers.add(handler);
    },
    exit: exitPromise,
    async kill(signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM') {
      if (killed) return;
      killed = true;
      try {
        if (signal === 'SIGKILL') {
          await handle.kill();
        } else {
          // 15 = SIGTERM (POSIX). Fall back to kill() if signal() throws.
          try { await handle.signal(15); } catch { await handle.kill(); }
        }
      } catch (err) {
        log.debug({ err }, 'kill failed (process likely already exited)');
      }
    },
    get killed() { return killed; },
    get pid() { return pid; },
  };

  return proc;
}

// ── Factory ──────────────────────────────────────────────────────────

export function createSandboxService(deps: {
  logger: Logger;
  localRegistry?: LocalRegistry;
}): SandboxService {
  const { logger, localRegistry } = deps;

  const activeSandboxes = new Map<string, SandboxState>();
  const createLocks = new Map<string, Mutex>();

  // ── Helpers ──────────────────────────────────────────────────────

  function getSandboxName(runId: string): string {
    return `vibe-${runId.slice(0, 12)}`;
  }

  function assertSandboxExists(sandboxName: string): SandboxState {
    const state = activeSandboxes.get(sandboxName);
    if (!state) throw new SandboxNotFoundError(sandboxName);
    return state;
  }

  // ── Core operations ─────────────────────────────────────────────

  async function create(options: SandboxCreateOptions): Promise<string> {
    const sandboxName = getSandboxName(options.runId);
    const log = logger.child({ sandboxName, runId: options.runId });

    if (activeSandboxes.has(sandboxName)) {
      log.info('Sandbox already tracked, reusing');
      return sandboxName;
    }

    const memMib = memoryToMiB(options.memory);

    // Validate env-var keys up front (defence-in-depth — credentials are
    // typically already validated at credential-vault build time, but we
    // mirror the legacy guard so misuse fails loudly at boot rather than later
    // inside the SDK with an opaque NAPI error).
    const envVars = options.credentials?.envVars ?? [];
    for (const { key } of envVars) assertValidEnvVarKey(key);

    log.info(
      {
        image: options.image,
        memMib,
        cpus: options.cpus,
        envKeys: envVars.map((e) => e.key),
        extraWorkspaces: options.extraWorkspaces ?? [],
      },
      'Creating microsandbox sandbox',
    );

    const builder = Sandbox.builder(sandboxName);
    // .replace() lets us overwrite any stale microsandbox-DB entry with the
    // same name (e.g. from a previously-crashed daemon). Combined with the
    // run-status cleanup in index.ts, this avoids "sandbox already exists"
    // failures on retry without needing a separate cleanup pass.
    builder.replace();

    // Image ref handling — when the local registry has a copy of the image,
    // rewrite the boot ref to point at it and mark it insecure (plain HTTP).
    // For images already qualified with a registry host (ghcr.io/..., etc.)
    // we leave the ref alone and let microsandbox pull from the upstream.
    let bootImage = options.image;
    let useLocalRegistry = false;
    if (bootImage && localRegistry && !localRegistry.isRegistryQualified(bootImage)) {
      // Boot the local registry on first use so the manifest probe below has
      // somewhere to talk to.
      try {
        await localRegistry.ensureRunning();
      } catch (err) {
        log.warn({ err }, 'Failed to start local registry; will try upstream');
      }
      try {
        if (await localRegistry.manifestExists(bootImage)) {
          bootImage = localRegistry.rewriteImageRef(bootImage);
          useLocalRegistry = true;
        }
      } catch (err) {
        log.debug({ err }, 'local registry manifest probe failed; using upstream ref');
      }
    }
    if (bootImage) builder.image(bootImage);
    if (useLocalRegistry) {
      builder.registry((r: any) => r.insecure());
      log.info({ bootImage }, 'Using local-registry copy of image');
    }
    if (options.cpus !== undefined && options.cpus > 0) builder.cpus(options.cpus);
    if (memMib !== undefined) builder.memory(memMib);
    // Run the sandbox as root. Background: microsandbox's bind-mount layer
    // does NOT remap host uids to guest uids — files owned by the host user
    // (e.g. uid 501 on macOS) appear as the same numeric uid inside the
    // guest, which usually has its own non-root user (uid 1000 in our agent
    // image). Without root, the agent cannot write into the project
    // worktree. Sandbox isolation comes from the microVM boundary, not the
    // in-guest user account, so running as root inside is safe.
    builder.user('root');

    // Mount the worktree at the same absolute path inside the guest (parity
    // with the legacy sbx workspace semantics). Read-write so the agent can
    // modify files.
    builder.volume(options.workdir, (b: any) => b.bind(options.workdir));
    // extraWorkspaces (e.g. the parent project's .git directory for worktree
    // ref resolution) must be read-write — git commit / fetch / etc. write
    // into <parent-.git>/worktrees/<branch>/. Read-only here would break
    // every git mutation inside the sandbox.
    for (const path of options.extraWorkspaces ?? []) {
      builder.volume(path, (b: any) => b.bind(path));
    }

    // Credential mounts (read-only, mounted at containerPath inside the guest).
    if (options.credentials) {
      for (const m of options.credentials.fileMounts) {
        const guestPath = m.containerPath || m.hostPath;
        builder.volume(guestPath, (b: any) => b.bind(m.hostPath).readonly());
      }
      for (const m of options.credentials.hostDirMounts) {
        const guestPath = m.containerPath || m.hostPath;
        builder.volume(guestPath, (b: any) => b.bind(m.hostPath).readonly());
      }
      for (const { key, value } of envVars) {
        builder.env(key, value);
      }
      // Docker logins inside the sandbox are deferred to post-create exec
      // (handled below) — there's no native SDK affordance for that flow.
    }

    // Network policy: default deny-egress, allow @public + @host so the
    // in-sandbox MCP bridge can reach the daemon at host.microsandbox.internal.
    const netConfig = options.network ?? {};
    const policy = buildNetworkPolicy(netConfig);
    builder.network((n: any) => {
      // Use the SDK's `policy(obj)` shim — it translates the camelCase TS
      // shape (with `{kind, ...data}` destination discriminator) into the
      // snake_case + externally-tagged wire form the Rust runtime expects.
      // `policyJson(JSON.stringify(policy))` would skip that translation and
      // fail with `unknown variant 'kind'`.
      n.policy(policy);
      if (netConfig.disableDnsRebindProtection || netConfig.nameservers) {
        n.dns((d: any) => {
          if (netConfig.disableDnsRebindProtection) d.rebindProtection(false);
          if (netConfig.nameservers && netConfig.nameservers.length > 0) {
            d.nameservers(netConfig.nameservers);
          }
          return d;
        });
      }
      if (netConfig.trustHostCas) n.trustHostCAs(true);
      return n;
    });

    let sandbox: Sandbox;
    try {
      sandbox = await builder.create();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Map "already exists" to the same idempotency-friendly error the
      // legacy implementation surfaced. The SDK doesn't expose a typed
      // duplicate-name error, so we string-match conservatively.
      if (/already exists/i.test(msg)) {
        throw new SandboxAlreadyExistsError(sandboxName);
      }
      throw new SandboxProvisionError(sandboxName, `microsandbox create failed: ${msg}`);
    }

    activeSandboxes.set(sandboxName, {
      runId: options.runId,
      sandboxName,
      envVars,
      sandbox,
    });

    // Post-create credential setup that has no native equivalent: docker logins.
    if (options.credentials?.dockerLogins?.length) {
      for (const login of options.credentials.dockerLogins) {
        log.debug({ registry: login.registry }, 'Running docker login inside sandbox');
        // Must use execStreamWith + stdinPipe(); plain execStream() does not
        // open a writable stdin, so takeStdin() would return null and the
        // password would never be written.
        const handle = await sandbox.execStreamWith('docker', (b: any) =>
          b.args([
            'login', login.registry,
            '--username', login.username,
            '--password-stdin',
          ]).stdinPipe(),
        );
        const sink = await handle.takeStdin();
        if (!sink) {
          throw new SandboxExecError(
            sandboxName,
            `docker login ${login.registry}`,
            1,
            'stdin sink unavailable for password injection',
          );
        }
        await sink.write(Buffer.from(login.password));
        await sink.close();
        const status = await handle.wait();
        if (!status.success) {
          throw new SandboxExecError(
            sandboxName,
            `docker login ${login.registry}`,
            status.code,
            '',
          );
        }
      }
    }

    log.info('Sandbox created successfully');
    return sandboxName;
  }

  async function getOrCreate(options: SandboxCreateOptions): Promise<string> {
    const sandboxName = getSandboxName(options.runId);

    const lock = createLocks.get(sandboxName) ?? new Mutex();
    createLocks.set(sandboxName, lock);

    return lock.runExclusive(async () => {
      const log = logger.child({ sandboxName, runId: options.runId });
      if (activeSandboxes.has(sandboxName)) {
        log.debug('Sandbox already tracked, reusing');
        return sandboxName;
      }
      try {
        return await create(options);
      } catch (err) {
        if (err instanceof SandboxAlreadyExistsError) {
          // Could happen if a previous daemon left orphaned DB entries. Try
          // to remove + re-create rather than blindly adopting an unknown
          // sandbox.
          log.warn('Sandbox name conflict; attempting to remove stale entry and recreate');
          try { await Sandbox.remove(sandboxName); } catch { /* ignore */ }
          return await create(options);
        }
        throw err;
      }
    }, 30 * 60_000); // 30 min — accommodates first-time image pulls for large agent images.
  }

  async function execInteractive(
    sandboxName: string,
    options: SandboxExecOptions,
  ): Promise<SandboxProcess> {
    const state = assertSandboxExists(sandboxName);
    const log = logger.child({ sandboxName });

    // microsandbox's execStreamWith doesn't support a workdir flag the way
    // the legacy sbx CLI did — but the SandboxBuilder.workdir() applies to
    // every exec, and individual execs can override via cwd().
    const handle = await state.sandbox.execStreamWith(options.command[0], (b) => {
      if (options.command.length > 1) b.args(options.command.slice(1));
      if (options.workdir) b.cwd(options.workdir);
      if (options.env) {
        for (const [k, v] of Object.entries(options.env)) {
          assertValidEnvVarKey(k);
          b.env(k, v);
        }
      }
      b.stdinPipe();
      return b;
    });

    return await bridgeExecHandle(handle, sandboxName, log);
  }

  async function execCommand(
    sandboxName: string,
    options: SandboxExecOptions,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const state = assertSandboxExists(sandboxName);

    const output = await state.sandbox.execWith(options.command[0], (b) => {
      if (options.command.length > 1) b.args(options.command.slice(1));
      if (options.workdir) b.cwd(options.workdir);
      if (options.env) {
        for (const [k, v] of Object.entries(options.env)) {
          assertValidEnvVarKey(k);
          b.env(k, v);
        }
      }
      return b;
    });

    const result = {
      stdout: output.stdout(),
      stderr: output.stderr(),
      exitCode: output.code,
    };

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
    return Object.fromEntries(state.envVars.map(({ key, value }) => [key, value]));
  }

  async function stop(sandboxName: string, _forceKillTimeout?: number): Promise<void> {
    const state = activeSandboxes.get(sandboxName);
    if (!state) return;

    const log = logger.child({ sandboxName });
    log.info('Stopping sandbox');
    try {
      await state.sandbox.stop();
    } catch (err) {
      log.warn({ err }, 'sandbox.stop() failed; falling back to kill');
      try { await state.sandbox.kill(); } catch { /* idempotent */ }
    }
    try {
      await Sandbox.remove(sandboxName);
    } catch (err) {
      log.debug({ err }, 'Sandbox.remove() failed (may already be removed)');
    }
    activeSandboxes.delete(sandboxName);
    log.info('Sandbox stopped and removed');
  }

  async function remove(sandboxName: string): Promise<void> {
    const log = logger.child({ sandboxName });
    log.info('Removing sandbox');

    // If we still hold an active handle for this sandbox, stop it cleanly
    // first. Microsandbox's `Sandbox.remove` (the static method) refuses to
    // delete a running sandbox and throws `SandboxStillRunningError`. The
    // common path here is "finalize cleanup raced with sessionManager.stop"
    // — be defensive and tear it down before removing.
    const state = activeSandboxes.get(sandboxName);
    if (state) {
      try { await state.sandbox.stop(); }
      catch (err) { log.debug({ err }, 'stop() during remove failed; attempting kill'); }
      try { await state.sandbox.kill(); } catch { /* idempotent */ }
      try { await Sandbox.remove(sandboxName); } catch { /* idempotent */ }
      activeSandboxes.delete(sandboxName);
      return;
    }

    // No tracked state — use static remove. If the underlying sandbox is
    // still running (e.g. created by a previous daemon process), fall back
    // to get→kill→remove so we don't leak.
    try {
      await Sandbox.remove(sandboxName);
    } catch (err) {
      if (err instanceof MsbSandboxNotFoundError) {
        log.debug('Sandbox already removed');
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      if (/still running/i.test(msg)) {
        try {
          const handle = await Sandbox.get(sandboxName);
          try { await handle.kill(); } catch { /* idempotent */ }
          try { await handle.remove(); } catch { /* idempotent */ }
          return;
        } catch (err2) {
          log.warn({ err: err2 }, 'Sandbox.remove() fallback failed');
          return;
        }
      }
      log.warn({ err }, 'Sandbox.remove() failed');
    }
  }

  async function forceStop(sandboxName: string): Promise<void> {
    const log = logger.child({ sandboxName });
    log.info('Force-stopping sandbox');
    const state = activeSandboxes.get(sandboxName);
    if (state) {
      try { await state.sandbox.kill(); } catch (err) { log.debug({ err }, 'kill failed'); }
      try { await Sandbox.remove(sandboxName); } catch { /* ignore */ }
      activeSandboxes.delete(sandboxName);
      return;
    }
    // No active state — try the static removal path.
    try {
      const handle = await Sandbox.get(sandboxName);
      try { await handle.kill(); } catch { /* may already be stopped */ }
      try { await handle.remove(); } catch { /* idempotent */ }
    } catch (err) {
      if (!(err instanceof MsbSandboxNotFoundError)) {
        log.warn({ err }, 'forceStop fallback failed');
      }
    }
  }

  async function list(): Promise<SandboxInfo[]> {
    let handles;
    try {
      handles = await Sandbox.list();
    } catch (err) {
      logger.warn({ err }, 'Sandbox.list() failed');
      return [];
    }
    const out: SandboxInfo[] = [];
    for (const h of handles) {
      if (!h.name.startsWith('vibe-')) continue;
      // `vibe-registry` is the daemon-managed local container registry, not a
      // workflow-run sandbox — exclude it from this view.
      if (h.name === 'vibe-registry') continue;
      const status: SandboxInfo['status'] =
        h.status === 'running' ? 'running' : h.status === 'stopped' ? 'stopped' : 'unknown';
      let image = '';
      try {
        const cfg = JSON.parse(h.configJson) as { image?: string };
        image = cfg.image ?? '';
      } catch { /* ignore */ }
      out.push({
        name: h.name,
        status,
        image,
        created: h.createdAt ? h.createdAt.toISOString() : '',
      });
    }
    return out;
  }

  return {
    create,
    getOrCreate,
    execInteractive,
    execCommand,
    getEnvVars,
    stop,
    remove,
    forceStop,
    list,
    isActive: (name) => activeSandboxes.has(name),
    getSandboxName,
  };
}
