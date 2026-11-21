import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { RunRef } from "./activities.js";

/** A workspace, a member who may use agents, and a planned agent run, committed for real. */
export async function seedRun(
  pool: pg.Pool,
  opts: { interactive?: boolean; kind?: RunRef["kind"] } = {},
): Promise<RunRef> {
  const one = async (sql: string, params: unknown[]) =>
    (await pool.query<{ id: string }>(sql, params)).rows[0]?.id ?? "";
  const slug = `ws-${randomUUID().slice(0, 8)}`;
  const workspaceId = await one(
    "insert into core.workspace (slug, name, region) values ($1, $1, 'au') returning id",
    [slug],
  );
  const role = await one(
    "insert into core.role (workspace_id, name, permissions) values ($1, 'U', $2) returning id",
    [workspaceId, ["agents.use", "threads.use"]],
  );
  const userId = await one(
    `insert into core."user" (workspace_id, email, role_id, status)
     values ($1, $2, $3, 'active') returning id`,
    [workspaceId, `a@${slug}.test`, role],
  );
  const thread = await one(
    "insert into work.thread (workspace_id, owner_id, title) values ($1, $2, 'T') returning id",
    [workspaceId, userId],
  );
  const question = await one(
    `insert into work.message (workspace_id, thread_id, role, content)
     values ($1, $2, 'user', 'go') returning id`,
    [workspaceId, thread],
  );
  const kind = opts.kind ?? "agent";
  const runId = await one(
    `insert into work.run (workspace_id, thread_id, owner_id, kind, status, question_id,
                           subject_id, interactive)
     values ($1, $2, $3, $4, 'planned', $5, gen_random_uuid(), $6) returning id`,
    [workspaceId, thread, userId, kind, question, opts.interactive ?? true],
  );
  return {
    runId,
    workspaceId,
    userId,
    kind,
    interactive: opts.interactive ?? true,
    budget: { max_cost_usd: null, max_tokens: 5_000_000 },
  };
}
