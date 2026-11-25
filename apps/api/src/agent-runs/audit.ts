import type { ActivityDeps, RunRef } from "@legallabs/runs";
import type pg from "pg";
import { asApp } from "../db.js";

/** Audit events a run writes as its owner: started, finished, plan approved. */
export function runAudit(pool: pg.Pool): NonNullable<ActivityDeps["audit"]> {
  return async (ref: RunRef, action, details) => {
    const object = ref.kind === "workflow" || ref.kind === "assistant" ? ref.kind : "agent";
    // Workflow runs say `workflow.run.started`; agent runs say `agent.run.started`.
    const name = action.replace(/^agent\./, `${object}.`);
    await asApp(pool, { userId: ref.userId, workspaceId: ref.workspaceId }, (db) =>
      db.query("select admin.append_audit_event($1, 'user', $2, $3, $4, $5, null, null)", [
        name,
        ref.userId,
        object,
        ref.runId,
        JSON.stringify(details),
      ]),
    );
  };
}
