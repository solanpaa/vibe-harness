import { describe, it, expect } from 'vitest';
import { Mutex } from '../../src/lib/mutex.js';

describe('Mutex', () => {
  // ── Core contract: mutual exclusion ─────────────────────────────────

  it('prevents concurrent access to a shared resource', async () => {
    const mutex = new Mutex();
    let counter = 0;

    // A non-atomic read-modify-write: without the mutex, concurrent
    // tasks would interleave and produce a wrong final count.
    const increment = () =>
      mutex.runExclusive(async () => {
        const val = counter;
        await new Promise((r) => setTimeout(r, 5)); // yield to event loop
        counter = val + 1;
      });

    await Promise.all(Array.from({ length: 20 }, () => increment()));
    // With true mutual exclusion, counter MUST be exactly 20.
    // Without the mutex the interleaving would leave it far less.
    expect(counter).toBe(20);
  });

  it('serializes tasks in FIFO order', async () => {
    const mutex = new Mutex();
    const order: number[] = [];

    const task = (id: number) =>
      mutex.runExclusive(async () => {
        order.push(id);
        await new Promise((r) => setTimeout(r, 5));
      });

    await Promise.all([task(1), task(2), task(3)]);
    expect(order).toEqual([1, 2, 3]);
  });

  // ── Return value propagation ────────────────────────────────────────

  it('returns the value produced by the exclusive function', async () => {
    const mutex = new Mutex();
    const result = await mutex.runExclusive(async () => 42);
    expect(result).toBe(42);
  });

  it('returns different types (generic T)', async () => {
    const mutex = new Mutex();
    const str = await mutex.runExclusive(async () => 'hello');
    expect(str).toBe('hello');

    const obj = await mutex.runExclusive(async () => ({ a: 1 }));
    expect(obj).toEqual({ a: 1 });
  });

  // ── Error handling contract ─────────────────────────────────────────

  it('propagates errors from the exclusive function', async () => {
    const mutex = new Mutex();
    await expect(
      mutex.runExclusive(async () => { throw new Error('boom'); }),
    ).rejects.toThrow('boom');
  });

  it('releases the lock after an error so the next task can proceed', async () => {
    const mutex = new Mutex();

    await mutex.runExclusive(async () => { throw new Error('fail'); }).catch(() => {});

    // If the lock were stuck, this would hang forever
    const result = await mutex.runExclusive(async () => 'recovered');
    expect(result).toBe('recovered');
  });

  it('remains usable after multiple consecutive errors', async () => {
    const mutex = new Mutex();

    for (let i = 0; i < 5; i++) {
      await mutex.runExclusive(async () => { throw new Error(`err-${i}`); }).catch(() => {});
    }

    const result = await mutex.runExclusive(async () => 'still works');
    expect(result).toBe('still works');
  });

  // ── Timeout contract ────────────────────────────────────────────────

  it('rejects with timeout error when lock is held too long', async () => {
    const mutex = new Mutex();

    const blocker = mutex.runExclusive(
      () => new Promise((r) => setTimeout(r, 300)),
    );

    // This task will time out waiting for the lock
    const waiter = mutex.runExclusive(async () => 'never', 20);
    await expect(waiter).rejects.toThrow(/timed out/i);
    await blocker;
  });

  it('does not corrupt state when timeout occurs mid-queue', async () => {
    const mutex = new Mutex();
    const results: string[] = [];

    // Task A: holds lock 100ms
    const a = mutex.runExclusive(async () => {
      await new Promise((r) => setTimeout(r, 100));
      results.push('A');
    });

    // Task B: times out after 10ms
    const b = mutex.runExclusive(async () => {
      results.push('B');
    }, 10).catch(() => results.push('B-timeout'));

    // Task C: waits patiently
    const c = mutex.runExclusive(async () => {
      results.push('C');
    });

    await Promise.all([a, b, c]);

    // A runs first, B times out, C runs after A
    expect(results).toContain('A');
    expect(results).toContain('B-timeout');
    expect(results).toContain('C');
    expect(results).not.toContain('B');
  });

  // ── Sequential reuse ───────────────────────────────────────────────

  it('allows reuse after lock is released', async () => {
    const mutex = new Mutex();
    const r1 = await mutex.runExclusive(async () => 1);
    const r2 = await mutex.runExclusive(async () => 2);
    expect(r1).toBe(1);
    expect(r2).toBe(2);
  });
});
