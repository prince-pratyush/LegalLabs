import { type AnchorStore, publishAuditAnchor } from "@legallabs/db";
import type { ObjectStore } from "@legallabs/storage";
import type pg from "pg";
import { asApp, asWorker } from "../db.js";

const DAY_MS = 86_400_000;

/**
 * Writes each finished day's last audit hash to storage outside the database (06-security 9.1,
 * SEC-041). The chain alone cannot show that its tail was cut or the whole of it rewritten by
 * someone with database rights; an anchor held elsewhere can. Put the keys under
 * `audit-anchors/` on a bucket with Object Lock in compliance mode, so an anchor cannot be
 * replaced: the store here only ever adds.
 */
export interface AnchorJob {
  /** One pass over every workspace and the last few finished days; safe to repeat. */
  runOnce(): Promise<{ anchored: number; failed: number }>;
  start(): void;
  stop(): Promise<void>;
}

export const anchorStore = (store: ObjectStore): AnchorStore => ({
  async put(key, body) {
    // Never replaces: a day's anchor is the same every time it is computed, so "already there"
    // is success, and a different value already there is exactly what a verifier must see.
    await store.putIfAbsent(key, new TextEncoder().encode(body));
  },
});

export function createAnchorJob(
  pool: pg.Pool,
  options: {
    store: ObjectStore;
    /** How many finished days to cover each pass, so a day missed during an outage is caught up. */
    days?: number;
    intervalMs?: number;
    now?: () => number;
    log?: (line: string) => void;
  },
): AnchorJob {
  const days = options.days ?? 3;
  const interval = options.intervalMs ?? 6 * 60 * 60 * 1000;
  const now = options.now ?? Date.now;
  const sink = anchorStore(options.store);
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<unknown> | null = null;

  async function runOnce() {
    const workspaces = await asWorker(pool, async (db) => {
      const { rows } = await db.query<{ id: string }>("select admin.anchor_workspaces() as id");
      return rows.map((r) => r.id);
    });
    let anchored = 0;
    let failed = 0;
    for (const workspaceId of workspaces) {
      for (let back = 1; back <= days; back++) {
        const day = new Date(now() - back * DAY_MS).toISOString().slice(0, 10);
        try {
          // Under the workspace's own identity-less scope: the recorder needs only the workspace.
          const anchor = await asApp(pool, { userId: null, workspaceId }, (db) =>
            publishAuditAnchor(db, sink, day),
          );
          if (anchor) anchored += 1;
        } catch (err) {
          failed += 1;
          options.log?.(
            `audit anchor failed for ${day}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
    return { anchored, failed };
  }

  const tick = () => {
    running = runOnce()
      .then((r) => {
        if (r.failed) options.log?.(`audit anchors: ${r.anchored} written, ${r.failed} failed`);
      })
      .catch((err: unknown) =>
        options.log?.(
          `audit anchor pass failed: ${err instanceof Error ? err.message : String(err)}`,
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
