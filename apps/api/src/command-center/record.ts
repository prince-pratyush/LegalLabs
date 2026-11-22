import type pg from "pg";

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
