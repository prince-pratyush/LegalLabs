import type { ObjectStore } from "@legallabs/storage";
import type pg from "pg";
import { asWorker } from "../db.js";

export interface AnalyticsJob {
  /** One pass: materialises every workspace, then removes expired export files and rows. */
  runOnce(): Promise<{ days: number; expiredExports: number }>;
  start(): void;
  stop(): Promise<void>;
}

export function createAnalyticsJob(
  pool: pg.Pool,
  options: { store: ObjectStore; intervalMs?: number; log?: (line: string) => void },
): AnalyticsJob {
  const interval = options.intervalMs ?? 6 * 60 * 60 * 1000;
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<unknown> | null = null;

  async function runOnce() {
    const days = await asWorker(pool, async (db) => {
      const { rows } = await db.query<{ n: number }>("select analytics.materialise_all() as n");
      return rows[0]?.n ?? 0;
    });
    const expired = await asWorker(pool, async (db) => {
      const { rows } = await db.query<{ storage_key: string | null }>(
        "select storage_key from analytics.purge_expired_exports()",
      );
      return rows;
    });
    // After commit, so a crash here leaves an unreachable file, never a row without its file.
    for (const row of expired) if (row.storage_key) await options.store.delete(row.storage_key);
    return { days, expiredExports: expired.length };
  }

  const tick = () => {
    running = runOnce()
      .then(({ days, expiredExports }) => {
        options.log?.(`analytics: ${days} days materialised, ${expiredExports} exports expired`);
      })
      .catch((err: unknown) =>
        options.log?.(`analytics failed: ${err instanceof Error ? err.message : String(err)}`),
      )
      .finally(() => {
        running = null;
      });
  };

  return {
    runOnce,
    start() {
      if (timer) return;
      tick();
      timer = setInterval(() => {
        if (!running) tick();
      }, interval);
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      await running;
    },
  };
}
