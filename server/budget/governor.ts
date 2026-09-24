/** Async semaphore for concurrent claude processes (spec §8.6). */
export class Governor {
  private current: number;
  private running = 0;
  private readonly queue: Array<() => void> = [];

  constructor(limit: number) {
    this.current = Governor.check(limit);
  }

  private static check(n: number): number {
    if (!Number.isInteger(n) || n < 1) throw new RangeError(`limit must be a positive integer, got ${n}`);
    return n;
  }

  get limit(): number {
    return this.current;
  }

  get active(): number {
    return this.running;
  }

  get waiting(): number {
    return this.queue.length;
  }

  setLimit(n: number): void {
    this.current = Governor.check(n);
    this.drain();
  }

  acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      this.queue.push(() => resolve(this.makeRelease()));
      this.drain();
    });
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.running -= 1;
      this.drain();
    };
  }

  private drain(): void {
    while (this.running < this.current && this.queue.length > 0) {
      this.running += 1;
      this.queue.shift()!();
    }
  }
}
