import type { Gateway } from "@legallabs/model-gateway";
import type pg from "pg";
import type { Documents } from "../documents/documents.js";
import type { RunLog } from "../runs/log.js";
import { createCells } from "./cells.js";
import { createExports } from "./export.js";
import { createRunner } from "./runner.js";
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
    /** Lowered in tests, so the 10,000-file limit can be reached with a few files. */
    vaultDocumentLimit?: number;
  },
) {
  const runner = createRunner(pool, deps);
  return {
    runner,
    tables: createTables(pool, deps),
    cells: createCells(pool, { gateway: deps.gateway, runner }),
    exports: createExports(pool),
  };
}

export type ReviewTables = ReturnType<typeof createReviewTables>;
