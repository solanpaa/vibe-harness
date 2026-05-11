// ---------------------------------------------------------------------------
// Sandbox prerequisite checks (microsandbox).
//
// Verifies the `microsandbox` SDK can be loaded at daemon startup AND the
// platform-specific runtime binaries (`libkrunfw`, `msb`) are installed at
// `~/.microsandbox/{lib,bin}/`. When the daemon runs from a bundled location
// (Nitro dev bundle, packaged binary), the NAPI module's `__dirname` no
// longer resolves next to its native peer, so it falls back to the canonical
// `~/.microsandbox/` install location. If that's missing, `Sandbox.create()`
// fails with `libkrunfw not found`. We bootstrap it on first boot via
// `setup.install()`.
// ---------------------------------------------------------------------------

import type { Logger } from 'pino';

export async function checkSandboxRuntimeAvailable(logger: Logger): Promise<boolean> {
  let mod: typeof import('microsandbox');
  try {
    mod = (await import('microsandbox')) as typeof import('microsandbox');
  } catch (err) {
    logger.warn(
      { err },
      'microsandbox SDK unavailable. Install with: npm i microsandbox; ' +
        'and ensure your platform is supported (macOS Apple Silicon, Linux x64/arm64). ' +
        'Daemon will start, but workflow runs will fail until the SDK loads.',
    );
    return false;
  }

  if (typeof mod.Sandbox !== 'function' && typeof mod.Sandbox !== 'object') {
    logger.warn('microsandbox SDK loaded but Sandbox export is missing — version mismatch?');
    return false;
  }

  // Ensure the runtime binaries (libkrunfw, msb) are installed at the
  // canonical search path. Safe to call repeatedly — `install()` short-
  // circuits when binaries are already present.
  try {
    if (mod.isInstalled()) {
      logger.info('microsandbox SDK detected (runtime binaries present)');
      return true;
    }
    logger.info('microsandbox runtime binaries missing; installing to ~/.microsandbox/...');
    await mod.install();
    logger.info('microsandbox runtime binaries installed');
    return true;
  } catch (err) {
    logger.warn(
      { err },
      'Failed to install microsandbox runtime binaries. Sandbox provisioning will fail until they are present at ~/.microsandbox/lib/.',
    );
    return false;
  }
}
