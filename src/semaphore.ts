/**
 * Minimal async semaphore with timeout on acquire.
 *
 * Used to cap concurrent `claude -p` spawns so a peer cannot overwhelm the
 * answering side by opening many sessions in parallel.
 */
export class Semaphore {
  private permits: number;
  private waiters: Array<() => void> = [];

  constructor(permits: number) {
    if (!Number.isFinite(permits) || permits < 1) {
      throw new Error(`Semaphore permits must be >= 1, got ${permits}`);
    }
    this.permits = permits;
  }

  async acquire(timeoutMs: number): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const onGrant = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const i = this.waiters.indexOf(onGrant);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error(`Semaphore acquire timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.waiters.push(onGrant);
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
      return;
    }
    this.permits++;
  }
}
