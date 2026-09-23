/** Fixed-window, in-memory rate limiter keyed by client (good enough for a single instance). */
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Returns 0 if allowed, otherwise the number of seconds to wait. */
  take(key: string): number {
    const t = this.now();
    const w = this.windows.get(key);
    if (!w || t - w.start >= this.windowMs) {
      this.windows.set(key, { start: t, count: 1 });
      if (this.windows.size > 10_000) this.prune(t);
      return 0;
    }
    if (w.count >= this.limit) return Math.ceil((w.start + this.windowMs - t) / 1000);
    w.count++;
    return 0;
  }

  private prune(t: number) {
    for (const [k, w] of this.windows) if (t - w.start >= this.windowMs) this.windows.delete(k);
  }
}
