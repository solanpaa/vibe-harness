// Helpers for inspecting Docker images on the host.
//
// Used by:
//   - GET  /api/agents/:id/image-status — surface build state to GUI
//   - POST /api/runs                    — pre-flight check before provisioning sandbox
//
// Notes:
//   - We shell out to the Docker CLI rather than the Engine API because the daemon
//     already requires `docker`/`sbx` on PATH and this avoids an extra dependency.
//   - `docker image inspect` returns exit code 0 when the image exists locally,
//     non-zero otherwise.

import { execFileSync } from 'node:child_process';

export interface ImageInfo {
  exists: true;
  image: string;
  imageId: string;
  created: string;
  sizeBytes: number;
}

export interface ImageMissing {
  exists: false;
  image: string;
}

/**
 * Returns true if the given Docker image reference is present locally.
 * Returns false on any inspect failure (missing image, daemon unreachable, …).
 */
export function dockerImageExists(image: string): boolean {
  if (!image) return false;
  try {
    execFileSync('docker', ['image', 'inspect', image, '--format', '{{.Id}}'], {
      stdio: ['ignore', 'ignore', 'ignore'],
      timeout: 5_000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Inspect a Docker image and return structured metadata, or a missing marker.
 */
export function inspectDockerImage(image: string): ImageInfo | ImageMissing {
  if (!image) return { exists: false, image };
  try {
    const out = execFileSync(
      'docker',
      ['image', 'inspect', image, '--format', '{{.Id}} {{.Created}} {{.Size}}'],
      { encoding: 'utf-8', timeout: 5_000 },
    ).trim();

    const [imageId, created, size] = out.split(' ');
    return {
      exists: true,
      image,
      imageId: imageId ?? '',
      created: created ?? '',
      sizeBytes: parseInt(size ?? '0', 10) || 0,
    };
  } catch {
    return { exists: false, image };
  }
}
