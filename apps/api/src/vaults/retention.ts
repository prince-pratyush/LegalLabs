import { contentKey, type ObjectStore } from "@legallabs/storage";
import type pg from "pg";
import { asWorker } from "../db.js";
import { BIN_DAYS } from "./vaults.js";

export interface RetentionJob {
  /**
   * One pass: empties the vault bin of items older than 30 days. Retention, including a vault's
   * own setting, is the policy sweep's work (retention/job.ts).
   */
  runOnce(): Promise<{ purgedFiles: number }>;
  start(): void;
  stop(): Promise<void>;
}

export function createRetentionJob(
  pool: pg.Pool,
  options: { store: ObjectStore; intervalMs?: number; log?: (line: string) => void },
): RetentionJob {
  const interval = options.intervalMs ?? 60 * 60 * 1000;
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<unknown> | null = null;

  async function runOnce() {
    const gone = await asWorker(pool, async (db) => {
      const { rows } = await db.query<{ workspace_id: string; sha256: Buffer }>(
        "select workspace_id, sha256 from content.purge_expired_bin($1)",
        [BIN_DAYS],
      );
      return rows;
    });
    // After commit, so a crash here leaves an unreachable object, never a row without its file.
    for (const row of gone) {
      await options.store.delete(contentKey(row.workspace_id, row.sha256.toString("hex")));
    }
    return { purgedFiles: gone.length };
  }

  const tick = () => {
    running = runOnce()
      .then(({ purgedFiles }) => {
        if (purgedFiles) options.log?.(`vault bin: ${purgedFiles} files purged`);
      })
      .catch((err: unknown) =>
        options.log?.(
          `vault bin purge failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
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
