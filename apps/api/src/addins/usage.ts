import type pg from "pg";
import { track, trackOutcome, trackUsage } from "../command-center/record.js";
import type { CountAddinUse } from "./routes.js";

/** A pane tool is a Word ask: one per action, whatever number of requests it took. */
export const createAddinUsage =
  (pool: pg.Pool): CountAddinUse =>
  (principal, { tool, batchId, last }) =>
    track(pool, principal, async (db) => {
      const key = batchId ? `${principal.userId}:${batchId}` : undefined;
      await trackUsage(db, {
        surface: "word",
        accessPoint: "word",
        action: `word.${tool}`,
        actionClass: "query",
        counter: "word",
        sourceKinds: ["file"],
        documentCount: 1,
        ...(key ? { once: `addin:${key}` } : {}),
      });
      if (tool === "translate" && last) {
        await trackOutcome(db, {
          workflowType: "translation_completed",
          ...(key ? { once: `translation:${key}` } : {}),
        });
      }
    });
