import type pg from "pg";
import { asUser, type Identity } from "./db.js";
import type { RunStatusName } from "./lifecycle.js";

export const FINISHED_STATUSES = ["done", "failed", "cancelled"] as const;

export interface RunRow {
  id: string;
  workspace_id: string;
  owner_id: string;
  thread_id: string | null;
  kind: "agent" | "workflow" | "agent_builder";
  subject_id: string;
  agent_version_id: string | null;
  workflow_version_id: string | null;
  task_id: string | null;
  space_id: string | null;
  matter_id: string | null;
  test_mode: boolean;
  interactive: boolean;
  status: RunStatusName;
  plan: unknown;
  cost_usd: number;
  path: string | null;
}

export interface StepRecord {
  id: string;
  ordinal: number;
  kind: string;
  status: string;
  block_id: string | null;
  label: string | null;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  cost_usd: number;
}

export interface StepStart {
  ordinal: number;
  kind: string;
  block_id?: string;
  label?: string;
  parent_step_id?: string;
  input?: Record<string, unknown>;
  idempotency_key?: string;
}

export interface StepFinish {
  status: "done" | "failed" | "skipped" | "awaiting_user";
  model?: string;
  routing_class?: string;
  usage?: { input_tokens: number; output_tokens: number; cached_tokens?: number };
  cost_usd?: number;
  output?: Record<string, unknown>;
  error?: { code: string; message: string; retryable: boolean };
}

export interface Totals {
  steps: number;
  tokens: number;
  cost_usd: number;
}

/** Every database read and write a run makes, as its owner. */
export interface RunStore {
  run(): Promise<RunRow | null>;
  setStatus(status: RunStatusName, errorCode?: string): Promise<void>;
  setPaused(paused: boolean): Promise<void>;
  setPlan(plan: unknown): Promise<void>;
  event(type: string, data: Record<string, unknown>): Promise<number>;
  step(ordinal: number): Promise<StepRecord | null>;
  stepById(stepId: string): Promise<StepRecord | null>;
  /** Makes the step row, or returns the one an earlier attempt made. */
  beginStep(start: StepStart): Promise<{ step: StepRecord; created: boolean }>;
  /** Finishes a step and keeps the run's cost equal to the sum of its steps. */
  finishStep(ordinal: number, result: StepFinish): Promise<void>;
  mergeOutput(ordinal: number, extra: Record<string, unknown>): Promise<void>;
  totals(): Promise<Totals>;
}

const STEP_COLUMNS = `id, ordinal, kind, status, block_id, label, input, output,
  coalesce(cost_usd, 0)::float8 as cost_usd`;

export function createRunStore(pool: pg.Pool, who: Identity, runId: string): RunStore {
  const as = <T>(work: (db: pg.PoolClient) => Promise<T>) => asUser(pool, who, work);
  const getStep = async (db: pg.PoolClient, ordinal: number) =>
    (
      await db.query<StepRecord>(
        `select ${STEP_COLUMNS} from work.run_step where run_id = $1 and ordinal = $2`,
        [runId, ordinal],
      )
    ).rows[0] ?? null;

  const store: RunStore = {
    run: () =>
      as(async (db) => {
        const { rows } = await db.query<RunRow>(
          `select id, workspace_id, owner_id, thread_id, kind, subject_id, agent_version_id,
                  workflow_version_id, task_id, space_id, matter_id, test_mode, interactive,
                  status, plan, cost_usd::float8 as cost_usd, path
             from work.run where id = $1`,
          [runId],
        );
        return rows[0] ?? null;
      }),

    setStatus: (status, errorCode) =>
      as(async (db) => {
        const done = (FINISHED_STATUSES as readonly string[]).includes(status);
        await db.query(
          `update work.run set status = $2, updated_at = now(),
                  finished_at = case when $3 then coalesce(finished_at, now()) else finished_at end,
                  error_code = coalesce($4, error_code)
            where id = $1`,
          [runId, status, done, errorCode ?? null],
        );
      }),

    setPaused: (paused) =>
      as(async (db) => {
        await db.query("update work.run set paused = $2, updated_at = now() where id = $1", [
          runId,
          paused,
        ]);
      }),

    setPlan: (plan) =>
      as(async (db) => {
        await db.query("update work.run set plan = $2, updated_at = now() where id = $1", [
          runId,
          JSON.stringify(plan),
        ]);
      }),

    event: (type, data) =>
      as(async (db) => {
        const { rows } = await db.query<{ seq: number }>(
          `insert into work.run_event (workspace_id, run_id, seq, type, data)
           select $1, $2, coalesce(max(seq), 0) + 1, $3, $4 from work.run_event where run_id = $2
           returning seq`,
          [who.workspaceId, runId, type, JSON.stringify(data)],
        );
        return rows[0]?.seq ?? 0;
      }),

    step: (ordinal) => as((db) => getStep(db, ordinal)),

    stepById: (stepId) =>
      as(async (db) => {
        const { rows } = await db.query<StepRecord>(
          `select ${STEP_COLUMNS} from work.run_step where run_id = $1 and id = $2`,
          [runId, stepId],
        );
        return rows[0] ?? null;
      }),

    beginStep: (start) =>
      as(async (db) => {
        const { rowCount } = await db.query(
          `insert into work.run_step (workspace_id, run_id, ordinal, kind, status, block_id, label,
                                      parent_step_id, input, idempotency_key)
           values ($1, $2, $3, $4, 'running', $5, $6, $7, $8, $9)
           on conflict (run_id, ordinal) do nothing`,
          [
            who.workspaceId,
            runId,
            start.ordinal,
            start.kind,
            start.block_id ?? null,
            start.label ?? null,
            start.parent_step_id ?? null,
            JSON.stringify(start.input ?? {}),
            start.idempotency_key ?? null,
          ],
        );
        const step = await getStep(db, start.ordinal);
        if (!step) throw new Error("step vanished");
        return { step, created: (rowCount ?? 0) > 0 };
      }),

    finishStep: (ordinal, r) =>
      as(async (db) => {
        await db.query(
          `update work.run_step
              set status = $3, model = $4, routing_class = $5, usage = coalesce($6::jsonb, usage),
                  cost_usd = coalesce($7, cost_usd), output = output || $8::jsonb, error = $9,
                  finished_at = case when $3 in ('done', 'failed', 'skipped') then now()
                                     else finished_at end
            where run_id = $1 and ordinal = $2`,
          [
            runId,
            ordinal,
            r.status,
            r.model ?? null,
            r.routing_class ?? null,
            r.usage ? JSON.stringify({ cached_tokens: 0, ...r.usage }) : null,
            r.cost_usd ?? null,
            JSON.stringify(r.output ?? {}),
            r.error ? JSON.stringify(r.error) : null,
          ],
        );
        // The run's cost is always the sum of its steps, never a running total that a retry could skew.
        await db.query(
          `update work.run set updated_at = now(),
                  cost_usd = (select coalesce(sum(cost_usd), 0) from work.run_step where run_id = $1)
            where id = $1`,
          [runId],
        );
      }),

    mergeOutput: (ordinal, extra) =>
      as(async (db) => {
        await db.query(
          "update work.run_step set output = output || $3::jsonb where run_id = $1 and ordinal = $2",
          [runId, ordinal, JSON.stringify(extra)],
        );
      }),

    totals: () =>
      as(async (db) => {
        const { rows } = await db.query<{ steps: number; tokens: number; cost: number }>(
          `select count(*)::int steps,
                  coalesce(sum((usage->>'input_tokens')::bigint
                             + (usage->>'output_tokens')::bigint), 0)::float8 tokens,
                  coalesce(sum(cost_usd), 0)::float8 cost
             from work.run_step where run_id = $1`,
          [runId],
        );
        const r = rows[0];
        return { steps: r?.steps ?? 0, tokens: r?.tokens ?? 0, cost_usd: r?.cost ?? 0 };
      }),
  };
  return store;
}
