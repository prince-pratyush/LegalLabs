import type { Gateway } from "@legallabs/model-gateway";
import type pg from "pg";
import type { Documents } from "../documents/documents.js";
import type { Notifier } from "../notifications/notify.js";
import type { RunLog } from "../runs/log.js";
import { createCells } from "./cells.js";
import { createExports } from "./export.js";
import { createRunner } from "./runner.js";
import { createTableSync } from "./sync.js";
import { createTables } from "./tables.js";

/** Everything the review-table routes need, built once per process. */
export function createReviewTables(
  pool: pg.Pool,
  deps: {
    gateway: Gateway;
    documents: Documents;
    log: RunLog;
    cellsInFlight?: number;
    dependencyPollMs?: number;
    /** Where a sync pass reports rows it added, for owners who opted in to hear of it. */
    notifier?: Notifier;
    syncIntervalMs?: number;
    syncLog?: (line: string) => void;
    /** Lowered in tests, so the 10,000-file limit can be reached with a few files. */
    vaultDocumentLimit?: number;
  },
) {
  const runner = createRunner(pool, deps);
  const cells = createCells(pool, { gateway: deps.gateway, runner });
  return {
    runner,
    tables: createTables(pool, deps),
    cells,
    exports: createExports(pool),
    sync: createTableSync(pool, {
      cells,
      ...(deps.notifier ? { notifier: deps.notifier } : {}),
      ...(deps.syncIntervalMs ? { intervalMs: deps.syncIntervalMs } : {}),
      ...(deps.syncLog ? { log: deps.syncLog } : {}),
    }),
  };
}

export type ReviewTables = ReturnType<typeof createReviewTables>;
