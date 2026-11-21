/** In-process wake-ups for open streams, keyed by user. The database stays the source of truth. */
export interface Hub {
  /** Tells a user's open streams to look for something new. */
  publish(userId: string): void;
  /** Returns a function that stops listening. */
  subscribe(userId: string, wake: () => void): () => void;
}

export function createHub(): Hub {
  const listeners = new Map<string, Set<() => void>>();
  return {
    publish(userId) {
      for (const wake of listeners.get(userId) ?? []) wake();
    },
    subscribe(userId, wake) {
      const set = listeners.get(userId) ?? new Set();
      set.add(wake);
      listeners.set(userId, set);
      return () => {
        set.delete(wake);
        if (set.size === 0) listeners.delete(userId);
      };
    },
  };
}
