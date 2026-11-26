import type pg from "pg";
import { asApp, type Identity } from "../db.js";
import { describeError } from "../log-error.js";

export type Surface =
  | "web"
  | "word"
  | "outlook"
  | "review_tables"
  | "agents"
  | "apps"
  | "email"
  | "api"
  | "mobile";

export type Counter =
  | "threads"
  | "follow_ups"
  | "agent_runs"
  | "playbook_runs"
  | "rt_columns"
  | "word"
  | "outlook";

export interface UsageInput {
  surface: Surface;
  /** Lower-case dotted name, e.g. "thread.message_sent". */
  action: string;
  actionClass: "query" | "other";
  counter?: Counter;
  accessPoint?: "web" | "word" | "outlook" | "mobile" | "api" | "email";
  subsurface?: string;
  objectType?: string;
  objectId?: string;
  matterRef?: string;
  sourceKinds?: string[];
  documentCount?: number;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  durationMs?: number;
  /** Backdates the event; tests and imports only. */
  at?: Date;
}

/**
 * Records one usage event as the signed-in person, inside the caller's transaction (a client
 * from asApp). Ids, counts and labels only: never prompt text, file names or quotes.
 */
export async function recordUsage(db: pg.PoolClient, e: UsageInput): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    "select analytics.record_usage($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) id",
    [
      e.surface,
      e.action,
      e.actionClass,
      e.counter ?? null,
      e.accessPoint ?? "web",
      e.subsurface ?? null,
      e.objectType ?? null,
      e.objectId ?? null,
      e.matterRef ?? null,
      e.sourceKinds ?? [],
      e.documentCount ?? 0,
      e.model ?? null,
      e.inputTokens ?? null,
      e.outputTokens ?? null,
      e.costUsd ?? null,
      e.durationMs ?? null,
      e.at ?? null,
    ],
  );
  return rows[0]?.id ?? "";
}

export type WorkflowType =
  | "contract_reviewed"
  | "redline_applied"
  | "table_exported"
  | "draft_exported"
  | "research_memo_completed"
  | "request_resolved"
  | "chronology_generated"
  | "translation_completed"
  | "proofread_applied";

export interface OutcomeInput {
  workflowType: WorkflowType;
  /** Rows, for a review table export; 1 otherwise. */
  quantity?: number;
  turnaroundSeconds?: number;
  at?: Date;
}

/** Records one completed piece of work; hours saved come from the baseline in force now. */
export async function recordOutcome(db: pg.PoolClient, e: OutcomeInput): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    "select analytics.record_outcome($1, $2, $3, $4) id",
    [e.workflowType, e.quantity ?? 1, e.turnaroundSeconds ?? null, e.at ?? null],
  );
  return rows[0]?.id ?? "";
}

// What features call. Recording is bookkeeping: it never fails the work it counts.

/** A key of ids naming something that counts once, however often it is repeated. */
export interface Once {
  once?: string | undefined;
}

export interface TrackedOutcome extends Omit<OutcomeInput, "turnaroundSeconds">, Once {
  /** When the originating object was created; turnaround runs from then. */
  since?: Date | undefined;
}

const failed = (name: string, err: unknown) =>
  console.error(`analytics: ${name} was not recorded: ${describeError(err)}`);

/**
 * Writes inside the caller's transaction, behind a savepoint: the event commits with the work
 * it counts, and a failure to write it is logged and rolled back on its own.
 */
async function guarded(
  db: pg.PoolClient,
  name: string,
  once: string | undefined,
  write: () => Promise<unknown>,
) {
  try {
    await db.query("savepoint analytics_record");
    try {
      const fresh =
        once === undefined ||
        (await db.query<{ ok: boolean }>("select analytics.claim_once($1) ok", [once])).rows[0]?.ok;
      if (fresh) await write();
      await db.query("release savepoint analytics_record");
    } catch (err) {
      await db.query("rollback to savepoint analytics_record");
      throw err;
    }
  } catch (err) {
    failed(name, err);
  }
}

export const trackUsage = (db: pg.PoolClient, e: UsageInput & Once) =>
  guarded(db, e.action, e.once, () => recordUsage(db, e));

export const trackOutcome = (db: pg.PoolClient, { once, since, ...e }: TrackedOutcome) =>
  guarded(db, e.workflowType, once, () =>
    recordOutcome(db, {
      ...e,
      ...(since
        ? { turnaroundSeconds: Math.max(0, Math.round((Date.now() - since.getTime()) / 1000)) }
        : {}),
    }),
  );

/** For work with no transaction left to join: writes as the person, in one of its own. */
export async function track(
  pool: pg.Pool,
  who: Identity,
  write: (db: pg.PoolClient) => Promise<unknown>,
): Promise<void> {
  try {
    await asApp(pool, who, write);
  } catch (err) {
    failed("an event", err);
  }
}
