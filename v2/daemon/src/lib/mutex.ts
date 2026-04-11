// ---------------------------------------------------------------------------
// Async Mutex (CDD §2.3)
//
// Simple async mutex for serializing access to shared resources.
// Used by WorktreeService (per-repo lock) and SessionManager (per-run lock).
// ---------------------------------------------------------------------------

export class Mutex {
  private queue: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];
  private locked = false;

  /**
   * Run `fn` while holding the lock exclusively.
   * @param timeoutMs Maximum wait time for lock acquisition (default 60 s).
   */
  async runExclusive<T>(fn: () => Promise<T>, timeoutMs = 60_000): Promise<T> {
    await this.acquire(timeoutMs);
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (!this.locked) {
        this.locked = true;
        resolve();
        return;
      }

      const entry = { resolve, reject };
      this.queue.push(entry);

      const timer = setTimeout(() => {
        const idx = this.queue.indexOf(entry);
        if (idx !== -1) {
          this.queue.splice(idx, 1);
          reject(
            new Error(
              `Mutex acquisition timed out after ${timeoutMs}ms. ` +
                `This may indicate a deadlock or a hung operation holding the lock.`,
            ),
          );
        }
      }, timeoutMs);

      const origResolve = entry.resolve;
      entry.resolve = () => {
        clearTimeout(timer);
        origResolve();
      };
    });
  }

  private release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      next.resolve();
    } else {
      this.locked = false;
    }
  }
}
