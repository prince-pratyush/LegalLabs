import { createHash } from "node:crypto";
import {
  type IntakeEscalation,
  type IntakeFieldValues,
  intakeEscalationHolds,
  intakeSlaState,
} from "@legallabs/contracts";
import type pg from "pg";
import { asWorker } from "../db.js";
import type { Notifier } from "../notifications/notify.js";

// What time does to a request: its SLA state, its type's escalations (structured conditions,
// compared and never run), reminders to a silent requester and closing it. Each change to a
// request brings it round at once, and otherwise every quarter of an hour.

interface Row {
  request_id: string;
  workspace_id: string;
  number: number;
  matter_id: string | null;
  fields: IntakeFieldValues;
  assignee_id: string | null;
  created_at: Date;
  sla_due_at: Date | null;
  sla_state: "ok" | "at_risk" | "breached";
  awaiting_since: Date | null;
  asked_field: string | null;
  unsent: boolean;
  timeout_hours: number;
  escalations: IntakeEscalation[];
}

const BATCH = 200;
const REMINDERS = 3;

export async function tellEscalated(
  notifier: Notifier,
  workspaceId: string,
  request: { id: string; number: number; matterId: string | null },
  people: readonly string[],
  actorId: string | null,
): Promise<void> {
  for (const userId of people) {
    await notifier.notify(
      { sessionId: "intake", userId: actorId ?? userId, workspaceId },
      {
        kind: "intake.request_escalated",
        actorId,
        objectType: "intake_request",
        objectId: request.id,
        // The number only: a title is also what email carries.
        objectTitle: `request #${request.number}`,
        matterId: request.matterId,
        people: { recipients: [userId] },
        url: `#/intake/requests/${request.id}`,
      },
    );
  }
}

export async function sweepIntake(
  pool: pg.Pool,
  options: { now: Date; notifier: Notifier; log: (line: string) => void },
  only: string[],
): Promise<void> {
  const { now, notifier, log } = options;
  const query = <T extends pg.QueryResultRow>(sql: string, params: unknown[]) =>
    asWorker(pool, async (db) => (await db.query<T>(sql, params)).rows);

  async function judge(row: Row) {
    const id = row.request_id;
    const state = row.sla_due_at ? intakeSlaState(row.created_at, row.sla_due_at, now) : "ok";
    if (state !== row.sla_state) await query("select apps.set_intake_sla($1, $2)", [id, state]);

    const context = {
      fields: row.fields,
      assigned: row.assignee_id !== null,
      created: row.created_at,
      sla: state,
      now,
    };
    for (const escalation of row.escalations) {
      if (!intakeEscalationHolds(escalation.when, context)) continue;
      const { target } = escalation;
      // The rule's own words name it, so an edited rule is a new one.
      const key = createHash("sha256").update(JSON.stringify(escalation)).digest("hex");
      const [fired] = await query<{ people: string[] }>(
        "select apps.fire_intake_escalation($1, $2, $3, $4, $5) people",
        [
          id,
          key,
          escalation.action,
          "user_id" in target ? target.user_id : null,
          "group_id" in target ? target.group_id : null,
        ],
      );
      await tellEscalated(
        notifier,
        row.workspace_id,
        { id, number: row.number, matterId: row.matter_id },
        fired?.people ?? [],
        null,
      );
    }

    // A requester is never closed out over a question that has not reached them.
    if (!row.awaiting_since || row.unsent) return;
    const waited = (now.getTime() - row.awaiting_since.getTime()) / 3_600_000;
    if (waited >= row.timeout_hours) {
      await query("select apps.expire_intake_request($1)", [id]);
      return;
    }
    const due = Math.min(REMINDERS, Math.floor(waited / (row.timeout_hours / (REMINDERS + 1))));
    if (due >= 1 && row.asked_field) {
      await query("select apps.remind_intake_requester($1, $2)", [
        id,
        `reminder:${row.awaiting_since.getTime()}:${due}`,
      ]);
    }
  }

  for (let n = 0; n < BATCH; n++) {
    const [row] = await query<Row>("select * from apps.claim_intake_sweep($1, $2)", [
      now,
      only.length > 0 ? only : null,
    ]);
    if (!row) return;
    try {
      await judge(row);
    } catch (err) {
      const { code } = err as { code?: string };
      log(`intake sweep ${row.request_id} failed: ${code ?? (err as Error).constructor.name}`);
    }
  }
}
