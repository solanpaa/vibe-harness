// Unit tests for the docker-image helpers. We don't shell out to a real
// daemon — we mock node:child_process so the tests are deterministic and
// run on machines without Docker installed.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const execFileSyncMock = vi.fn();

vi.mock('node:child_process', () => ({
  execFileSync: execFileSyncMock,
}));

const { dockerImageExists, inspectDockerImage } = await import('../../src/lib/docker-image.js');

beforeEach(() => {
  execFileSyncMock.mockReset();
});

describe('dockerImageExists', () => {
  it('returns false for empty image name without invoking docker', () => {
    expect(dockerImageExists('')).toBe(false);
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('returns true when docker inspect succeeds', () => {
    execFileSyncMock.mockReturnValue(Buffer.from('sha256:abc'));
    expect(dockerImageExists('foo:bar')).toBe(true);
  });

  it('returns false when docker inspect throws', () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error('No such image');
    });
    expect(dockerImageExists('foo:bar')).toBe(false);
  });
});

describe('inspectDockerImage', () => {
  it('returns missing marker for empty image name', () => {
    const result = inspectDockerImage('');
    expect(result).toEqual({ exists: false, image: '' });
  });

  it('parses inspect output into structured info', () => {
    execFileSyncMock.mockReturnValue('sha256:abcdef0123456789 2026-04-17T20:00:00Z 524288000\n');
    const result = inspectDockerImage('foo:bar');
    expect(result).toEqual({
      exists: true,
      image: 'foo:bar',
      imageId: 'sha256:abcdef0123456789',
      created: '2026-04-17T20:00:00Z',
      sizeBytes: 524288000,
    });
  });

  it('returns missing marker when inspect throws', () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error('boom');
    });
    expect(inspectDockerImage('foo:bar')).toEqual({ exists: false, image: 'foo:bar' });
  });
});

