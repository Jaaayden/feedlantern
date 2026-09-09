/** Bounded, FIFO-per-key pool. Jobs without keys are exclusive barriers. */
export class TaskPool {
  private pending: Array<{ keys: string[] | (() => string[]); run: () => Promise<void> }> = [];
  private active = new Set<string>();
  private running = 0;
  private exclusive = false;
  private waiters: Array<() => void> = [];
  constructor(readonly concurrency: number) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error('后台并发必须是 1–4 的整数');
  }
  enqueue<T>(operation: () => Promise<T> | T, keys: string[] | (() => string[]) = []): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.push({ keys, run: async () => { try { resolve(await operation()); } catch (error) { reject(error); } } });
      this.pump();
    });
  }
  drain(): Promise<void> {
    return this.running || this.pending.length ? new Promise(resolve => this.waiters.push(resolve)) : Promise.resolve();
  }
  private pump() {
    const blocked = new Set<string>();
    for (let index = 0; index < this.pending.length && this.running < this.concurrency && !this.exclusive;) {
      const job = this.pending[index];
      const keys = typeof job.keys === 'function' ? job.keys() : job.keys;
      if (!keys.length && this.running) break;
      if (keys.some(key => this.active.has(key) || blocked.has(key))) {
        keys.forEach(key => blocked.add(key)); index++; continue;
      }
      this.pending.splice(index, 1);
      this.running++;
      this.exclusive = !keys.length;
      keys.forEach(key => this.active.add(key));
      void job.run().finally(() => {
        this.running--; this.exclusive = false;
        keys.forEach(key => this.active.delete(key));
        this.pump();
        if (!this.running && !this.pending.length) this.waiters.splice(0).forEach(resolve => resolve());
      });
    }
  }
}

// Include all ports/schemes of a hostname in the same limit.
export function siteKey(url: string): string { return `site:${new URL(url).hostname.toLowerCase().replace(/\.$/, '')}`; }
