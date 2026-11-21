import type { RunSignal, RunSummary } from "@legallabs/contracts";
import type { RunEngine, RunRef } from "@legallabs/runs";
import type pg from "pg";
import { type Client, type Principal, uaHash } from "../auth/auth.js";
import { asApp } from "../db.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_MAX_TOKENS = 5_000_000;

export interface StartRun {
  kind: RunRef["kind"];
  /** The agent or workflow being run. */
  subject_id: string;
  agent_version_id?: string;
  workflow_version_id?: string;
  title: string;
  /** What the person typed or filled in; stored as the thread's first message. */
  inputs?: string;
  thread_id?: string;
  matter_id?: string;
  space_id?: string;
  task_id?: string;
  path: "page" | "mention" | "word" | "task" | "schedule";
  interactive?: boolean;
  test_mode?: boolean;
  max_cost_usd?: number | null;
  max_tokens?: number;
}

export interface StepSummary {
  id: string;
  ordinal: number;
  parent_step_id: string | null;
  kind: string;
  block_id: string | null;
  label: string | null;
  status: string;
  model: string | null;
  routing_class: string | null;
  usage: unknown;
  cost_usd: number;
  started_at: string;
  finished_at: string | null;
  summary: string | null;
  error: unknown;
}

export type SignalResult = "ok" | "NOT_FOUND" | "FORBIDDEN" | "FINISHED";

export interface RunFilter {
  kind?: "agent" | "workflow" | "agent_builder" | undefined;
  subject_id?: string | undefined;
  status?: string | undefined;
  /** Test runs stay out of lists unless asked for. */
  test_mode?: boolean | undefined;
  limit?: number | undefined;
}

export interface AgentRuns {
  /** Makes the thread, its first message and the run, then hands the run to the engine. */
  start(principal: Principal, request: StartRun): Promise<{ run_id: string; thread_id: string }>;
  list(principal: Principal, filter?: RunFilter): Promise<RunSummary[]>;
  get(principal: Principal, runId: string): Promise<RunSummary | null>;
  steps(principal: Principal, runId: string): Promise<StepSummary[] | null>;
  /** The full step, with its input and output, for the person who started the run only. */
  step(
    principal: Principal,
    runId: string,
    stepId: string,
  ): Promise<(StepSummary & { input?: unknown; output?: unknown }) | null>;
  signal(
    principal: Principal,
    runId: string,
    signal: RunSignal,
    client: Client,
  ): Promise<SignalResult>;
}

export interface AgentRunsOptions {
  engine: RunEngine;
  /**
   * Whether someone other than the run's owner may signal it: Full access on the agent, or
   * being admin of the run's Space. Supplied by the agents module; owner only until then.
   */
  mayControl?: (
    principal: Principal,
    run: { id: string; subject_id: string; space_id: string | null },
  ) => Promise<boolean>;
}

const SUMMARY_COLUMNS = `id, kind, subject_id, status, owner_id, created_at, finished_at,
  cost_usd::float8 as cost_usd, test_mode, task_id, thread_id, error_code`;

type SummaryRow = {
  id: string;
  kind: RunSummary["kind"];
  subject_id: string;
  status: string;
  owner_id: string;
  created_at: Date;
  finished_at: Date | null;
  cost_usd: number;
  test_mode: boolean;
  task_id: string | null;
  thread_id: string | null;
  error_code: string | null;
};

const toSummary = (r: SummaryRow): RunSummary => ({
  id: r.id,
  kind: r.kind,
  subject_id: r.subject_id,
  status: r.status,
  started_by: r.owner_id,
  started_at: r.created_at.toISOString(),
  finished_at: r.finished_at?.toISOString() ?? null,
  cost_usd: r.cost_usd,
  test_mode: r.test_mode,
  task_id: r.task_id,
  thread_id: r.thread_id,
  error_code: r.error_code,
});

type StepRow = {
  id: string;
  ordinal: number;
  parent_step_id: string | null;
  kind: string;
  block_id: string | null;
  label: string | null;
  status: string;
  model: string | null;
  routing_class: string | null;
  usage: unknown;
  cost_usd: number;
  started_at: Date;
  finished_at: Date | null;
  output: { summary?: string };
  error: unknown;
  input: unknown;
};

const STEP_COLUMNS = `id, ordinal, parent_step_id, kind, block_id, label, status, model,
  routing_class, usage, coalesce(cost_usd, 0)::float8 as cost_usd, started_at, finished_at,
  output, error, input`;

const toStep = (r: StepRow): StepSummary => ({
  id: r.id,
  ordinal: r.ordinal,
  parent_step_id: r.parent_step_id,
  kind: r.kind,
  block_id: r.block_id,
  label: r.label,
  status: r.status,
  model: r.model,
  routing_class: r.routing_class,
  usage: r.usage,
  cost_usd: r.cost_usd,
  started_at: r.started_at.toISOString(),
  finished_at: r.finished_at?.toISOString() ?? null,
  summary: typeof r.output?.summary === "string" ? r.output.summary : null,
  error: r.error,
});

export function createAgentRuns(pool: pg.Pool, options: AgentRunsOptions): AgentRuns {
  const { engine } = options;

  return {
    async start(principal, req) {
      const interactive = req.interactive ?? true;
      const ref = await asApp(pool, principal, async (db) => {
        let threadId = req.thread_id;
        if (!threadId) {
          const { rows } = await db.query<{ id: string }>(
            `insert into work.thread (workspace_id, owner_id, matter_id, title)
             values ($1, $2, $3, $4) returning id`,
            [
              principal.workspaceId,
              principal.userId,
              req.matter_id ?? null,
              req.title.slice(0, 200),
            ],
          );
          threadId = rows[0]?.id as string;
        }
        const { rows: msg } = await db.query<{ id: string }>(
          `insert into work.message (workspace_id, thread_id, role, content)
           values ($1, $2, 'user', $3) returning id`,
          [principal.workspaceId, threadId, req.inputs?.trim() || `Run ${req.title}`],
        );
        const { rows } = await db.query<{ id: string }>(
          `insert into work.run (workspace_id, thread_id, owner_id, kind, status, question_id,
                                 subject_id, agent_version_id, workflow_version_id, task_id,
                                 space_id, matter_id, test_mode, interactive, path)
           values ($1, $2, $3, $4, 'planned', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
           returning id`,
          [
            principal.workspaceId,
            threadId,
            principal.userId,
            req.kind,
            msg[0]?.id,
            req.subject_id,
            req.agent_version_id ?? null,
            req.workflow_version_id ?? null,
            req.task_id ?? null,
            req.space_id ?? null,
            req.matter_id ?? null,
            req.test_mode ?? false,
            interactive,
            req.path,
          ],
        );
        const runId = rows[0]?.id as string;
        await db.query("update work.run set engine_id = $2 where id = $1", [runId, `run:${runId}`]);
        return {
          ref: {
            runId,
            workspaceId: principal.workspaceId,
            userId: principal.userId,
            kind: req.kind,
            interactive,
            budget: {
              max_cost_usd: req.max_cost_usd ?? null,
              max_tokens: req.max_tokens ?? DEFAULT_MAX_TOKENS,
            },
          } satisfies RunRef,
          threadId,
        };
      });
      try {
        await engine.start(ref.ref);
      } catch (err) {
        // Never leave a planned run that nothing will pick up.
        await asApp(pool, principal, (db) =>
          db.query(
            "update work.run set status = 'failed', error_code = 'ENGINE_UNAVAILABLE', finished_at = now() where id = $1",
            [ref.ref.runId],
          ),
        );
        throw err;
      }
      return { run_id: ref.ref.runId, thread_id: ref.threadId };
    },

    list(principal, filter = {}) {
      return asApp(pool, principal, async (db) => {
        const { rows } = await db.query<SummaryRow>(
          `select ${SUMMARY_COLUMNS} from work.run
            where kind in ('agent', 'workflow', 'agent_builder')
              and ($1::text is null or kind = $1)
              and ($2::uuid is null or subject_id = $2)
              and ($3::text is null or status = $3)
              and ($4::boolean or not test_mode)
            order by created_at desc, id desc limit $5`,
          [
            filter.kind ?? null,
            filter.subject_id ?? null,
            filter.status ?? null,
            filter.test_mode ?? false,
            Math.min(filter.limit ?? 50, 200),
          ],
        );
        return rows.map(toSummary);
      });
    },

    async get(principal, runId) {
      if (!UUID.test(runId)) return null;
      return asApp(pool, principal, async (db) => {
        const { rows } = await db.query<SummaryRow>(
          `select ${SUMMARY_COLUMNS} from work.run
            where id = $1 and kind in ('agent', 'workflow', 'agent_builder')`,
          [runId],
        );
        return rows[0] ? toSummary(rows[0]) : null;
      });
    },

    async steps(principal, runId) {
      if (!UUID.test(runId)) return null;
      return asApp(pool, principal, async (db) => {
        const { rows: run } = await db.query("select 1 from work.run where id = $1", [runId]);
        if (run.length === 0) return null;
        const { rows } = await db.query<StepRow>(
          `select ${STEP_COLUMNS} from work.run_step where run_id = $1 order by ordinal`,
          [runId],
        );
        return rows.map(toStep);
      });
    },

    async step(principal, runId, stepId) {
      if (!UUID.test(runId) || !UUID.test(stepId)) return null;
      return asApp(pool, principal, async (db) => {
        const { rows } = await db.query<StepRow & { owner_id: string }>(
          `select s.id, s.ordinal, s.parent_step_id, s.kind, s.block_id, s.label, s.status,
                  s.model, s.routing_class, s.usage, coalesce(s.cost_usd, 0)::float8 as cost_usd,
                  s.started_at, s.finished_at, s.output, s.error, s.input, r.owner_id
             from work.run_step s join work.run r on r.id = s.run_id
            where s.run_id = $1 and s.id = $2`,
          [runId, stepId],
        );
        const row = rows[0];
        if (!row) return null;
        const summary = toStep(row);
        // Prompt and answer detail is the runner's; everyone else sees the summary.
        return row.owner_id === principal.userId
          ? { ...summary, input: row.input, output: row.output }
          : summary;
      });
    },

    async signal(principal, runId, signal, client) {
      if (!UUID.test(runId)) return "NOT_FOUND";
      const run = await asApp(pool, principal, async (db) => {
        const { rows } = await db.query<{
          id: string;
          owner_id: string;
          status: string;
          subject_id: string;
          space_id: string | null;
        }>(
          `select id, owner_id, status, subject_id, space_id from work.run
            where id = $1 and kind in ('agent', 'workflow', 'agent_builder')`,
          [runId],
        );
        return rows[0] ?? null;
      });
      if (!run) return "NOT_FOUND";
      const allowed =
        run.owner_id === principal.userId ||
        ((await options.mayControl?.(principal, run)) ?? false);
      if (!allowed) return "FORBIDDEN";
      if (["done", "failed", "cancelled"].includes(run.status)) return "FINISHED";
      await engine.signal(runId, signal);
      await asApp(pool, principal, (db) =>
        db.query("select admin.append_audit_event($1, 'user', $2, 'run', $3, $4, $5, $6)", [
          "run.signal",
          principal.userId,
          runId,
          JSON.stringify({ name: signal.name }),
          client.ip,
          uaHash(client),
        ]),
      );
      return "ok";
    },
  };
}
