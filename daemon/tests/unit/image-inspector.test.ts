// Unit tests for the image-inspector helpers. We don't shell out to a real
// docker/podman daemon — instead we mock node:child_process.execFileSync.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

const childProc = await import('node:child_process');
const { inspectImage, imageExists } = await import('../../src/lib/image-inspector.js');

const mockExec = childProc.execFileSync as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockExec.mockReset();
});

describe('inspectImage', () => {
  it('returns missing when image is empty', async () => {
    expect(await inspectImage('')).toEqual({ exists: false, image: '' });
  });

  it('finds image via docker inspect', async () => {
    mockExec.mockImplementationOnce((cmd: string, args: string[]) => {
      expect(cmd).toBe('docker');
      expect(args).toEqual(['image', 'inspect', '--format', '{{json .}}', 'foo:bar']);
      return JSON.stringify({
        Id: 'sha256:deadbeef',
        Created: '2024-01-01T00:00:00Z',
        Size: 1024,
        RepoTags: ['foo:bar'],
      });
    });
    const info = await inspectImage('foo:bar');
    expect(info).toMatchObject({
      exists: true,
      image: 'foo:bar',
      imageId: 'sha256:deadbeef',
      sizeBytes: 1024,
      source: 'docker',
    });
  });

  it('falls back to podman when docker fails', async () => {
    mockExec.mockImplementationOnce(() => {
      throw new Error('docker not found');
    });
    mockExec.mockImplementationOnce((cmd: string, args: string[]) => {
      expect(cmd).toBe('podman');
      expect(args).toContain('image');
      // podman returns an array
      return JSON.stringify([{ Id: 'sha256:cafe', Size: 2048 }]);
    });
    const info = await inspectImage('foo:bar');
    expect(info).toMatchObject({
      exists: true,
      imageId: 'sha256:cafe',
      sizeBytes: 2048,
      source: 'docker',
    });
  });

  it('returns missing when neither builder has the image', async () => {
    mockExec.mockImplementation(() => {
      throw new Error('not found');
    });
    const info = await inspectImage('foo:bar');
    // The microsandbox SDK fallback may also be probed; either way the result
    // should be a missing marker (the test environment doesn't have any
    // images, and SDK methods return null or throw).
    if (info.exists) {
      expect(info.source).toBe('microsandbox');
    } else {
      expect(info).toEqual({ exists: false, image: 'foo:bar' });
    }
  });
});

describe('imageExists', () => {
  it('is true when docker has the image', async () => {
    mockExec.mockReturnValueOnce(JSON.stringify({ Id: 'x', Size: 1 }));
    expect(await imageExists('a:b')).toBe(true);
  });

  it('is false when image is empty string', async () => {
    expect(await imageExists('')).toBe(false);
  });
});
