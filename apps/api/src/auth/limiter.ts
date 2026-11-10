export interface Limiter {
  /** Returns 0 if allowed, otherwise the seconds to wait. */
  take(key: string): number;
  size(): number;
}

export function createLimiter(options: {
  limit: number;
  windowMs: number;
  now?: () => number;
  maxKeys?: number;
}): Limiter {
  const { limit, windowMs, now = Date.now, maxKeys = 10_000 } = options;
  const windows = new Map<string, { count: number; resetAt: number }>();

  return {
    size: () => windows.size,
    take(key) {
      const at = now();
      if (windows.size >= maxKeys) {
        for (const [k, w] of windows) if (w.resetAt <= at) windows.delete(k);
      }
      const current = windows.get(key);
      if (!current || current.resetAt <= at) {
        windows.set(key, { count: 1, resetAt: at + windowMs });
        return 0;
      }
      if (current.count >= limit) return Math.ceil((current.resetAt - at) / 1000);
      current.count += 1;
      return 0;
    },
  };
}
