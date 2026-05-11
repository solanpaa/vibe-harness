// ---------------------------------------------------------------------------
// Image inspector — replaces the legacy `sbx template ls` lookup.
//
// With microsandbox, the SDK ships its own image cache (`msb pull`, `msb image
// ls`) AND can boot images directly from the host's docker/podman cache. The
// daemon builds agent images via `docker buildx build -t <ref> .` (see
// lib/image-builder.ts) and microsandbox's runtime can either:
//   a) inherit the host docker/podman image, OR
//   b) require a separate `msb pull <ref>` for any image the runtime hasn't
//      already cached.
//
// Recipes for "use a locally-built docker image directly" are documented in
// the microsandbox customize docs. To stay compatible across both paths, this
// module reports an image as "available" if it exists in EITHER the host
// docker/podman cache OR in microsandbox's image list.
// ---------------------------------------------------------------------------

import { execFileSync } from 'node:child_process';

export interface ImageInfo {
  exists: true;
  image: string;
  imageId: string;
  created: string;
  sizeBytes: number;
  /** Where the image was found: 'docker' (host) or 'microsandbox' (runtime cache) */
  source: 'docker' | 'microsandbox';
}

export interface ImageMissing {
  exists: false;
  image: string;
}

interface DockerInspectEntry {
  Id?: string;
  Created?: string;
  Size?: number;
  RepoTags?: string[];
}

function inspectDocker(image: string): ImageInfo | null {
  try {
    const out = execFileSync(
      'docker',
      ['image', 'inspect', '--format', '{{json .}}', image],
      { encoding: 'utf-8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    if (!out) return null;
    const entry = JSON.parse(out) as DockerInspectEntry;
    return {
      exists: true,
      image,
      imageId: entry.Id ?? '',
      created: entry.Created ?? '',
      sizeBytes: entry.Size ?? 0,
      source: 'docker',
    };
  } catch {
    return null;
  }
}

function inspectPodman(image: string): ImageInfo | null {
  try {
    const out = execFileSync(
      'podman',
      ['image', 'inspect', '--format', '{{json .}}', image],
      { encoding: 'utf-8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    if (!out) return null;
    // Podman returns an array literal even for a single image.
    const parsed = JSON.parse(out);
    const entry: DockerInspectEntry = Array.isArray(parsed) ? parsed[0] : parsed;
    return {
      exists: true,
      image,
      imageId: entry.Id ?? '',
      created: entry.Created ?? '',
      sizeBytes: entry.Size ?? 0,
      source: 'docker',
    };
  } catch {
    return null;
  }
}

async function inspectMicrosandbox(image: string): Promise<ImageInfo | null> {
  try {
    const { Image } = (await import('microsandbox')) as typeof import('microsandbox');
    const handle = await Image.get(image);
    return {
      exists: true,
      image,
      imageId: handle.manifestDigest ?? '',
      created: handle.createdAt ? handle.createdAt.toISOString() : '',
      sizeBytes: handle.sizeBytes ?? 0,
      source: 'microsandbox',
    };
  } catch {
    return null;
  }
}

/**
 * True if the image reference can be booted by `Sandbox.builder().image(ref)`.
 * Checks docker → podman → microsandbox in that order.
 */
export async function imageExists(image: string): Promise<boolean> {
  const info = await inspectImage(image);
  return info.exists;
}

/**
 * Look up an image by reference. Returns metadata or a missing marker.
 */
export async function inspectImage(image: string): Promise<ImageInfo | ImageMissing> {
  if (!image) return { exists: false, image };
  return (
    inspectDocker(image) ??
    inspectPodman(image) ??
    (await inspectMicrosandbox(image)) ??
    { exists: false, image }
  );
}
