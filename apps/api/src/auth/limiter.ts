export interface Limiter {
  /** Returns 0 if allowed, otherwise the seconds to wait. */
  take(key: string): number;
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
    take(key) {
      const at = now();
      if (!windows.has(key) && windows.size >= maxKeys) {
        for (const [k, w] of windows) if (w.resetAt <= at) windows.delete(k);
        // Refusing is the safe side: a flood must not grow memory or get a free pass.
        if (windows.size >= maxKeys) return Math.ceil(windowMs / 1000);
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
