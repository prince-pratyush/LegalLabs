import { contentKey, type ObjectStore } from "@legallabs/storage";
import type pg from "pg";
import { asWorker } from "../db.js";
import type { Notifier } from "../notifications/notify.js";

export interface RetentionSweepReport {
  binned: number;
  purged: number;
  filesDeleted: number;
  failures: number;
  warnings: number;
  /** SQLSTATEs of workspaces whose sweep failed outright; they are tried again next time. */
  errors: string[];
  /** Per-object failures from this pass; each is retried next time. */
  problems: unknown[];
}

export interface RetentionSweepJob {
  /** One pass: bins what has expired, purges what has sat in the bin 30 days, then warns. */
  runOnce(): Promise<RetentionSweepReport>;
  start(): void;
  stop(): Promise<void>;
}

interface WorkspaceResult {
  workspace_id: string;
  binned: number;
  purged: number;
  failures?: unknown[];
  blobs: string[];
  error?: string;
}

interface Warning {
  workspace_id: string;
  vault_id: string;
  vault_name: string;
  owner_id: string;
  matter_id: string | null;
  lead_days: number;
  admin_ids: string[];
}

export function createRetentionSweepJob(
  pool: pg.Pool,
  options: {
    store: ObjectStore;
    notifications?: Notifier;
    intervalMs?: number;
    log?: (line: string) => void;
  },
): RetentionSweepJob {
  const interval = options.intervalMs ?? 60 * 60 * 1000;
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<unknown> | null = null;

  async function runOnce(): Promise<RetentionSweepReport> {
    const results = await asWorker(pool, async (db) => {
      const { rows } = await db.query<{ r: WorkspaceResult[] }>("select retention.sweep_all() r");
      return rows[0]?.r ?? [];
    });
    const report: RetentionSweepReport = {
      binned: 0,
      purged: 0,
      filesDeleted: 0,
      failures: 0,
      warnings: 0,
      errors: [],
      problems: [],
    };
    for (const result of results) {
      report.binned += result.binned;
      report.purged += result.purged;
      report.failures += (result.failures?.length ?? 0) + (result.error ? 1 : 0);
      report.problems.push(...(result.failures ?? []));
      if (result.error) report.errors.push(result.error);
      // After commit, so a crash here leaves an unreachable object, never a row without its file.
      for (const hash of result.blobs) {
        try {
          await options.store.delete(contentKey(result.workspace_id, hash));
          report.filesDeleted += 1;
        } catch (err) {
          report.failures += 1;
          options.log?.(
            `retention: file delete failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    if (options.notifications) {
      const warnings = await asWorker(pool, async (db) => {
        const { rows } = await db.query<Warning>("select * from retention.due_warnings()");
        return rows;
      });
      for (const w of warnings) {
        // Sent as the vault's owner, who is in the workspace; the notifier checks each walled reader.
        await options.notifications.notify(
          { sessionId: "", userId: w.owner_id, workspaceId: w.workspace_id },
          {
            kind: "vault.retention_warning",
            actorId: null,
            objectType: "vault",
            objectId: w.vault_id,
            objectTitle: w.vault_name,
            matterId: w.matter_id,
            people: { owner: w.owner_id, recipients: w.admin_ids },
          },
        );
        report.warnings += 1;
      }
    }
    return report;
  }

  const tick = () => {
    running = runOnce()
      .then((r) => {
        if (r.binned || r.purged || r.failures || r.warnings)
          options.log?.(
            `retention: ${r.binned} binned, ${r.purged} purged, ${r.filesDeleted} files deleted, ${r.failures} failures, ${r.warnings} warnings`,
          );
      })
      .catch((err: unknown) =>
        options.log?.(
          `retention sweep failed: ${err instanceof Error ? err.message : String(err)}`,
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
