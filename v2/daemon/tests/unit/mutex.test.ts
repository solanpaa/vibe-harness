import { describe, it, expect } from 'vitest';
import { Mutex } from '../../src/lib/mutex.js';

describe('Mutex', () => {
  it('serializes concurrent access', async () => {
    const mutex = new Mutex();
    const order: number[] = [];

    const task = (id: number, delayMs: number) =>
      mutex.runExclusive(async () => {
        order.push(id);
        await new Promise((r) => setTimeout(r, delayMs));
        return id;
      });

    // Launch 3 tasks concurrently
    const [r1, r2, r3] = await Promise.all([
      task(1, 30),
      task(2, 10),
      task(3, 10),
    ]);

    expect(r1).toBe(1);
    expect(r2).toBe(2);
    expect(r3).toBe(3);
    // All three ran in the order they were queued
    expect(order).toEqual([1, 2, 3]);
  });

  it('rejects after timeout', async () => {
    const mutex = new Mutex();

    // Hold the lock for 200ms
    const blocker = mutex.runExclusive(
      () => new Promise((r) => setTimeout(r, 200)),
    );

    // Try to acquire with a very short timeout
    const timeouter = mutex.runExclusive(async () => 'done', 10);

    await expect(timeouter).rejects.toThrow(/timed out/);
    await blocker; // clean up
  });

  it('releases lock on error (no deadlock)', async () => {
    const mutex = new Mutex();

    // First task throws
    await expect(
      mutex.runExclusive(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    // Second task should still acquire the lock
    const result = await mutex.runExclusive(async () => 'success');
    expect(result).toBe('success');
  });

  it('allows sequential access after release', async () => {
    const mutex = new Mutex();
    const r1 = await mutex.runExclusive(async () => 1);
    const r2 = await mutex.runExclusive(async () => 2);
    expect(r1).toBe(1);
    expect(r2).toBe(2);
  });

  it('handles many concurrent tasks', async () => {
    const mutex = new Mutex();
    const results: number[] = [];

    const tasks = Array.from({ length: 20 }, (_, i) =>
      mutex.runExclusive(async () => {
        results.push(i);
        return i;
      }),
    );

    await Promise.all(tasks);
    expect(results).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });
});
