// ---------------------------------------------------------------------------
// sbx prerequisite checks and one-time policy bootstrap.
//
// Runs at daemon startup to:
//   1. Verify the `sbx` CLI is installed (and warn if missing).
//   2. Ensure `localhost:<daemonPort>` is in the global sbx network policy
//      allowlist so the in-sandbox MCP bridge (which connects to the daemon
//      via http://host.docker.internal:<daemonPort>) is permitted.
//
// All operations are best-effort: failures log a clear warning but do not
// prevent the daemon from starting.
// ---------------------------------------------------------------------------

import { execCommand } from './shell.js';
import type { Logger } from 'pino';

export async function checkSbxAvailable(logger: Logger): Promise<boolean> {
  try {
    const result = await execCommand('sbx', ['--version'], { timeout: 5_000 });
    if (result.exitCode === 0) {
      logger.info({ version: result.stdout.trim() }, 'sbx CLI detected');
      return true;
    }
    logger.warn(
      { stderr: result.stderr },
      'sbx CLI returned non-zero exit code on --version. Install/upgrade: https://docs.docker.com/ai/sandboxes/',
    );
    return false;
  } catch (err) {
    logger.warn(
      { err },
      'sbx CLI not found or not executable. Install with: brew install docker/tap/sbx (macOS). Daemon will start, but workflow runs will fail until sbx is available.',
    );
    return false;
  }
}

/**
 * Ensure the global sbx network policy allows `localhost:<daemonPort>`.
 *
 * The in-sandbox MCP bridge (see workflows/steps/execute-stage.ts) connects
 * to the daemon via http://host.docker.internal:<daemonPort>. sbx's proxy
 * translates host.docker.internal → localhost on the host, so an explicit
 * allow rule is required.
 *
 * `sbx policy allow network` is additive and idempotent; running it on each
 * startup is safe.
 */
export async function ensureLocalhostPolicy(
  daemonPort: number,
  logger: Logger,
): Promise<void> {
  const target = `localhost:${daemonPort}`;
  try {
    const result = await execCommand(
      'sbx',
      ['policy', 'allow', 'network', target],
      { timeout: 10_000 },
    );
    if (result.exitCode === 0) {
      logger.info({ target }, 'sbx network policy allows in-sandbox MCP bridge');
    } else {
      logger.warn(
        { target, stderr: result.stderr },
        'Failed to add sbx network policy for in-sandbox MCP bridge. Run manually: sbx policy allow network ' + target,
      );
    }
  } catch (err) {
    logger.warn(
      { err, target },
      'Could not ensure sbx network policy. Hooks/MCP from inside sandboxes will fail until you run: sbx policy allow network ' + target,
    );
  }
}
