// ---------------------------------------------------------------------------
// Local container registry — runs `registry:3` on the host as a docker (or
// podman) container so the daemon can push host-built images and microsandbox
// can pull them back when booting agent sandboxes.
//
// Why this exists:
//   Microsandbox's image pull happens host-side over OCI registry HTTP. It
//   does NOT read from the host docker/podman image cache. To boot a
//   locally-built agent image (e.g. `vibe-harness/copilot:latest`), we need
//   a registry the daemon can push to and microsandbox can pull from.
//
// Why docker/podman and NOT microsandbox-hosted:
//   We initially hosted the registry inside its own microsandbox VM. The
//   microsandbox SDK's image-pull layer reliably stalls when pulling FROM a
//   registry that's running INSIDE another microsandbox VM on the same host
//   (likely a NAPI / connection-pool interaction we did not isolate).
//   Hosting the registry as a plain docker container — which the host
//   already requires for building images — sidesteps the issue and yields
//   fast (~1s) pulls.
//
// How it works:
//   - Boots a `registry:3` container named `vibe-registry` on host port 5050.
//   - Persists pushed layers in `~/.vibe-harness/registry-data/` via a host
//     bind mount, so images survive daemon restarts.
//   - Writes `~/.microsandbox/config.json` declaring `127.0.0.1:5050` as
//     insecure so the microsandbox SDK talks plain HTTP.
//   - Clears stale `*.download.lock` and `*.part` files in
//     `~/.microsandbox/cache/tmp/` left by previous crashed pulls so
//     `Sandbox.create()` doesn't deadlock on a lock held by a dead process.
//   - Started lazily on first `ensureRunning()` call.
//
// Reachability:
//   - From the host (daemon process): `http://127.0.0.1:5050/`
//   - From inside microsandbox VMs (e.g. an agent sandbox at runtime):
//     image pulls happen BEFORE the guest boots, so the agent never needs to
//     reach the registry. Only the host does.
// ---------------------------------------------------------------------------

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Logger } from 'pino';

const execFileAsync = promisify(execFile);

const REGISTRY_CONTAINER_NAME = 'vibe-registry';
const REGISTRY_HOST_PORT = 5050;
const REGISTRY_GUEST_PORT = 5000;
const REGISTRY_IMAGE = 'registry:3';
const REGISTRY_DATA_DIR = join(homedir(), '.vibe-harness', 'registry-data');
const READY_TIMEOUT_MS = 60_000;
const MICROSANDBOX_CONFIG_PATH = join(homedir(), '.microsandbox', 'config.json');

/**
 * Microsandbox's image pull layer downloads OCI blobs into
 * `~/.microsandbox/cache/tmp/` and uses `<digest>.download.lock` files to
 * coordinate concurrent pulls. When the daemon (or any host process holding
 * the SDK) is killed mid-pull, those lock files remain on disk — every
 * subsequent `Sandbox.create()` then *waits forever* on the stale lock.
 *
 * Best-effort cleanup at daemon startup: ignore any I/O errors so transient
 * filesystem issues don't block startup.
 */
function clearStaleDownloadLocks(logger: Logger): void {
  const tmpDir = join(homedir(), '.microsandbox', 'cache', 'tmp');
  if (!existsSync(tmpDir)) return;
  let lockCount = 0;
  let partCount = 0;
  try {
    for (const entry of readdirSync(tmpDir)) {
      if (entry.endsWith('.download.lock')) {
        try { unlinkSync(join(tmpDir, entry)); lockCount++; } catch { /* ignore */ }
      } else if (entry.endsWith('.part')) {
        try { unlinkSync(join(tmpDir, entry)); partCount++; } catch { /* ignore */ }
      }
    }
    if (lockCount > 0 || partCount > 0) {
      logger.info(
        { lockCount, partCount },
        'Cleared stale microsandbox download locks / partial blobs',
      );
    }
  } catch (err) {
    logger.debug({ err }, 'Could not scan microsandbox cache/tmp for stale locks');
  }
}

/**
 * Ensure `~/.microsandbox/config.json` lists our local registry's endpoint
 * (both 127.0.0.1 and localhost variants) as insecure so the SDK's pull
 * layer talks plain HTTP. Merges with any existing config rather than
 * overwriting it.
 */
function ensureInsecureRegistryConfig(logger: Logger): void {
  let cfg: any = {};
  if (existsSync(MICROSANDBOX_CONFIG_PATH)) {
    try {
      cfg = JSON.parse(readFileSync(MICROSANDBOX_CONFIG_PATH, 'utf-8'));
    } catch (err) {
      logger.warn({ err }, 'Could not parse existing ~/.microsandbox/config.json; overwriting');
      cfg = {};
    }
  }
  cfg.registries = cfg.registries ?? {};
  cfg.registries.hosts = cfg.registries.hosts ?? {};
  const hosts = [
    `127.0.0.1:${REGISTRY_HOST_PORT}`,
    `localhost:${REGISTRY_HOST_PORT}`,
  ];
  let changed = false;
  for (const h of hosts) {
    const existing = cfg.registries.hosts[h];
    if (!existing || existing.insecure !== true) {
      cfg.registries.hosts[h] = { ...(existing ?? {}), insecure: true };
      changed = true;
    }
  }
  if (changed) {
    const dir = join(homedir(), '.microsandbox');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(MICROSANDBOX_CONFIG_PATH, JSON.stringify(cfg, null, 2));
    logger.info({ hosts }, 'Marked local-registry endpoints as insecure in ~/.microsandbox/config.json');
  }
}

async function detectContainerRuntime(): Promise<'docker' | 'podman'> {
  try {
    await execFileAsync('docker', ['version'], { timeout: 5_000 });
    return 'docker';
  } catch {
    /* try podman */
  }
  try {
    await execFileAsync('podman', ['version'], { timeout: 5_000 });
    return 'podman';
  } catch {
    throw new Error(
      'Neither docker nor podman is available on PATH. ' +
        'Install one of them to host the local container registry.',
    );
  }
}

export interface PushOptions {
  /** Receives chunks of `docker push` stdout/stderr for streaming UIs. */
  onLine?: (chunk: string) => void;
}

export interface LocalRegistry {
  /** Lazily boots the registry container. Idempotent. */
  ensureRunning(): Promise<void>;
  /** Clear stale download locks at startup (best-effort, idempotent). */
  cleanStartupState(): void;
  /** Tears down the registry container. Persisted layers stay on disk. */
  stop(): Promise<void>;
  /** Host-side endpoint (what daemon + microsandbox use to pull). */
  endpoint(): string;
  /**
   * Endpoint for *pushing* from container-based builders like docker buildx
   * on Docker Desktop, where the builder runs in its own VM and cannot
   * reach the host's `localhost`/`127.0.0.1`. On macOS/Windows we return
   * `host.docker.internal:5050`; on Linux (where buildx shares the host's
   * network namespace) we return the same as `endpoint()`.
   */
  pushEndpoint(): string;
  isRegistryQualified(image: string): boolean;
  rewriteImageRef(image: string): string;
  pushRef(image: string): string;
  manifestExists(image: string): Promise<boolean>;
  pushImage(
    localTag: string,
    builder: 'docker' | 'podman',
    opts?: PushOptions,
  ): Promise<{ pushedRef: string }>;
}

export function createLocalRegistry(deps: { logger: Logger }): LocalRegistry {
  const { logger } = deps;
  let startPromise: Promise<void> | null = null;
  let runtime: 'docker' | 'podman' | null = null;

  function endpoint(): string {
    return `127.0.0.1:${REGISTRY_HOST_PORT}`;
  }

  function pushEndpoint(): string {
    if (process.platform === 'darwin' || process.platform === 'win32') {
      return `host.docker.internal:${REGISTRY_HOST_PORT}`;
    }
    return endpoint();
  }

  function isRegistryQualified(image: string): boolean {
    if (!image) return false;
    const firstSlash = image.indexOf('/');
    if (firstSlash <= 0) return false;
    const head = image.slice(0, firstSlash);
    return head.includes('.') || head.includes(':') || head === 'localhost';
  }

  function splitNameTag(image: string): { name: string; tag: string } {
    const i = image.lastIndexOf(':');
    const j = image.lastIndexOf('/');
    if (i > j) {
      return { name: image.slice(0, i), tag: image.slice(i + 1) };
    }
    return { name: image, tag: 'latest' };
  }

  function rewriteImageRef(image: string): string {
    if (!image) return image;
    if (isRegistryQualified(image)) return image;
    const { name, tag } = splitNameTag(image);
    return `${endpoint()}/${name}:${tag}`;
  }

  function pushRef(image: string): string {
    if (!image) return image;
    if (isRegistryQualified(image)) return image;
    const { name, tag } = splitNameTag(image);
    return `${pushEndpoint()}/${name}:${tag}`;
  }

  async function manifestExists(image: string): Promise<boolean> {
    if (!image) return false;
    const ref = isRegistryQualified(image) ? image : rewriteImageRef(image);
    if (!ref.startsWith(`${endpoint()}/`)) return false;
    const path = ref.slice(`${endpoint()}/`.length);
    const { name, tag } = splitNameTag(path);
    try {
      const r = await fetch(
        `http://${endpoint()}/v2/${name}/manifests/${tag}`,
        {
          method: 'HEAD',
          headers: {
            Accept:
              'application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json',
          },
          signal: AbortSignal.timeout(5_000),
        },
      );
      return r.status === 200;
    } catch {
      return false;
    }
  }

  async function isContainerRunning(): Promise<boolean> {
    if (!runtime) return false;
    try {
      const { stdout } = await execFileAsync(runtime, [
        'inspect',
        '--format',
        '{{.State.Running}}',
        REGISTRY_CONTAINER_NAME,
      ], { timeout: 5_000 });
      return stdout.trim() === 'true';
    } catch {
      return false;
    }
  }

  async function ensureRunning(): Promise<void> {
    if (startPromise) return startPromise;
    startPromise = (async () => {
      const log = logger.child({ component: 'local-registry' });

      try { ensureInsecureRegistryConfig(logger); }
      catch (err) { log.warn({ err }, 'Failed to update ~/.microsandbox/config.json'); }

      clearStaleDownloadLocks(logger);

      if (!existsSync(REGISTRY_DATA_DIR)) {
        mkdirSync(REGISTRY_DATA_DIR, { recursive: true });
        log.info({ dir: REGISTRY_DATA_DIR }, 'Created registry data dir');
      }

      runtime = await detectContainerRuntime();

      // Reuse if already running (e.g. left over from a prior daemon).
      if (await isContainerRunning()) {
        log.info('Local registry container already running; reusing');
      } else {
        // Remove any stopped/exited container with the same name so `run`
        // doesn't fail with "name already in use".
        try {
          await execFileAsync(runtime, ['rm', '-f', REGISTRY_CONTAINER_NAME], { timeout: 10_000 });
        } catch { /* not present */ }

        log.info(
          { image: REGISTRY_IMAGE, hostPort: REGISTRY_HOST_PORT, dataDir: REGISTRY_DATA_DIR, runtime },
          'Starting local registry container',
        );

        const args = [
          'run',
          '-d',
          '--name', REGISTRY_CONTAINER_NAME,
          '--restart', 'unless-stopped',
          '-p', `${REGISTRY_HOST_PORT}:${REGISTRY_GUEST_PORT}`,
          '-v', `${REGISTRY_DATA_DIR}:/var/lib/registry`,
          REGISTRY_IMAGE,
        ];
        try {
          await execFileAsync(runtime, args, { timeout: 60_000 });
        } catch (err) {
          throw new Error(
            `Failed to start local registry via ${runtime}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // Poll for /v2/ readiness.
      const deadline = Date.now() + READY_TIMEOUT_MS;
      while (Date.now() < deadline) {
        try {
          const r = await fetch(`http://${endpoint()}/v2/`, {
            signal: AbortSignal.timeout(2_000),
          });
          if (r.status === 200 || r.status === 401) {
            log.info({ endpoint: endpoint(), runtime }, 'Local registry ready');
            return;
          }
        } catch { /* not ready */ }
        await new Promise((r) => setTimeout(r, 500));
      }
      throw new Error(
        `Local registry at ${endpoint()} did not become ready within ${READY_TIMEOUT_MS / 1000}s`,
      );
    })().catch((err) => {
      startPromise = null;
      throw err;
    });
    return startPromise;
  }

  async function stop(): Promise<void> {
    const log = logger.child({ component: 'local-registry' });
    if (!runtime) {
      // Try both — best-effort cleanup if the daemon never called ensureRunning().
      for (const r of ['docker', 'podman'] as const) {
        try {
          await execFileAsync(r, ['rm', '-f', REGISTRY_CONTAINER_NAME], { timeout: 10_000 });
          log.info({ runtime: r }, 'Local registry container removed');
        } catch { /* not present or runtime unavailable */ }
      }
      return;
    }
    try {
      await execFileAsync(runtime, ['rm', '-f', REGISTRY_CONTAINER_NAME], { timeout: 10_000 });
      log.info({ runtime }, 'Local registry container removed');
    } catch (err) {
      log.debug({ err }, 'Local registry stop failed (may already be gone)');
    }
    startPromise = null;
  }

  async function pushImage(
    localTag: string,
    builder: 'docker' | 'podman',
    opts?: PushOptions,
  ): Promise<{ pushedRef: string }> {
    await ensureRunning();
    const onLine = opts?.onLine ?? (() => {});
    const remoteRef = rewriteImageRef(localTag);

    onLine(`\n▶ ${builder} tag ${localTag} ${remoteRef}\n`);
    await new Promise<void>((resolve, reject) => {
      const child = execFile(builder, ['tag', localTag, remoteRef], { timeout: 60_000 });
      child.stderr?.on('data', (chunk: Buffer) => onLine(chunk.toString()));
      child.on('error', reject);
      child.on('close', (code: number | null) =>
        code === 0 ? resolve() : reject(new Error(`${builder} tag exited ${code}`)),
      );
    });

    onLine(`\n▶ ${builder} push ${remoteRef}\n`);
    const args =
      builder === 'docker'
        ? ['push', remoteRef]
        : ['push', '--tls-verify=false', remoteRef];
    await new Promise<void>((resolve, reject) => {
      const child = execFile(builder, args, { timeout: 1_200_000 });
      child.stdout?.on('data', (chunk: Buffer) => onLine(chunk.toString()));
      child.stderr?.on('data', (chunk: Buffer) => onLine(chunk.toString()));
      child.on('error', reject);
      child.on('close', (code: number | null) =>
        code === 0 ? resolve() : reject(new Error(`${builder} push exited ${code}`)),
      );
    });

    return { pushedRef: remoteRef };
  }

  return {
    ensureRunning,
    cleanStartupState() {
      try { clearStaleDownloadLocks(logger); }
      catch (err) { logger.debug({ err }, 'cleanStartupState failed'); }
      try { ensureInsecureRegistryConfig(logger); }
      catch (err) { logger.debug({ err }, 'ensureInsecureRegistryConfig at startup failed'); }
    },
    stop,
    endpoint,
    pushEndpoint,
    isRegistryQualified,
    rewriteImageRef,
    pushRef,
    manifestExists,
    pushImage,
  };
}
