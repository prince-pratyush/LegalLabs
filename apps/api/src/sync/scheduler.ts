import type pg from "pg";
import { asWorker } from "../db.js";
import type { SyncEngine } from "./engine.js";

export interface SyncSchedulerOptions {
  intervalMs?: number;
  /** How many vaults one tick starts; each runs one at a time so a slow drive can't starve the rest. */
  batch?: number;
  log?: (line: string) => void;
}

/**
 * Starts the syncs that are due. The spec calls for a Temporal workflow; until that engine is
 * wired, a due-queue in Postgres gives the same guarantees the engine needs: one run per vault
 * (the claim in `engine.run`) and a lease that expires if a worker dies mid-run.
 */
export function createSyncScheduler(
  pool: pg.Pool,
  engine: SyncEngine,
  options: SyncSchedulerOptions = {},
) {
  const log = options.log ?? (() => {});
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<void> | null = null;

  async function tick() {
    const due = await asWorker(
      pool,
      async (w) =>
        (
          await w.query<{ vault_id: string; workspace_id: string; owner_id: string }>(
            "select vault_id, workspace_id, owner_id from content.due_vault_syncs($1)",
            [options.batch ?? 10],
          )
        ).rows,
    );
    for (const d of due) {
      try {
        await engine.run(d.vault_id, d.workspace_id, d.owner_id);
      } catch (err) {
        log(`sync ${d.vault_id} crashed: ${err instanceof Error ? err.message : "unknown"}`);
      }
    }
  }

  const guarded = () => {
    running ??= tick()
      .catch((err) => log(`sync tick failed: ${err instanceof Error ? err.message : "unknown"}`))
      .finally(() => {
        running = null;
      });
    return running;
  };

  return {
    tick: guarded,
    start() {
      timer ??= setInterval(() => void guarded(), options.intervalMs ?? 30_000);
      timer.unref();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      await running;
    },
  };
}
