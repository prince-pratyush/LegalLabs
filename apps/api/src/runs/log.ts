import { EventEmitter } from "node:events";
import type { RunEvent } from "@legallabs/contracts";
import type pg from "pg";
import type { Principal } from "../auth/auth.js";
import { asApp } from "../db.js";

// Every event type minus its seq, which the log assigns.
export type NewEvent = RunEvent extends infer E
  ? E extends RunEvent
    ? Omit<E, "seq">
    : never
  : never;

export interface RunLog {
  /** Saves an event in order and tells live listeners. */
  append(principal: Principal, runId: string, event: NewEvent): Promise<RunEvent>;
  /** Saved events after `after`, for a page load or a reconnect. Empty if the run is hidden. */
  replay(principal: Principal, runId: string, after: number): Promise<RunEvent[]>;
  /** Events as they are saved, in this process. */
  subscribe(runId: string, listener: (event: RunEvent) => void): () => void;
  /** Forgets a finished run's counters; called once its work has stopped. */
  release(runId: string): void;
}

const REPLAY_LIMIT = 5_000;

export function createRunLog(pool: pg.Pool): RunLog {
  const live = new EventEmitter();
  live.setMaxListeners(0);
  const next = new Map<string, number>();
  // One write at a time per run, so seq order is save order.
  const queues = new Map<string, Promise<unknown>>();

  async function write(principal: Principal, runId: string, event: NewEvent) {
    return asApp(pool, principal, async (db) => {
      let seq = next.get(runId);
      if (seq === undefined) {
        const { rows } = await db.query<{ seq: number }>(
          "select coalesce(max(seq), 0) + 1 seq from work.run_event where run_id = $1",
          [runId],
        );
        seq = rows[0]?.seq ?? 1;
      }
      const { type, ...data } = event;
      await db.query(
        `insert into work.run_event (workspace_id, run_id, seq, type, data)
         values ($1, $2, $3, $4, $5)`,
        [principal.workspaceId, runId, seq, type, JSON.stringify(data)],
      );
      // Set before commit: a failed commit only leaves a gap in seq, never a repeat.
      next.set(runId, seq + 1);
      return { ...event, seq } as RunEvent;
    });
  }

  return {
    append(principal, runId, event) {
      const previous = queues.get(runId) ?? Promise.resolve();
      const written = previous.catch(() => {}).then(() => write(principal, runId, event));
      queues.set(runId, written);
      return written.then((saved) => {
        live.emit(runId, saved);
        return saved;
      });
    },

    replay(principal, runId, after) {
      return asApp(pool, principal, async (db) => {
        const { rows } = await db.query<{ seq: number; type: string; data: object }>(
          `select seq, type, data from work.run_event
            where run_id = $1 and seq > $2 order by seq limit $3`,
          [runId, after, REPLAY_LIMIT],
        );
        return rows.map((row) => ({ ...row.data, type: row.type, seq: row.seq }) as RunEvent);
      });
    },

    release(runId) {
      next.delete(runId);
      queues.delete(runId);
    },

    subscribe(runId, listener) {
      live.on(runId, listener);
      return () => live.off(runId, listener);
    },
  };
}
