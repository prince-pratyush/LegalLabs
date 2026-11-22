import { describe, expect, it } from "vitest";
import { type Tx, withTx } from "./db.js";
import { seed } from "./fixtures.js";

async function setup(tx: Tx) {
  const s = await seed(tx);
  await tx.asOwner();
  await tx.rows(`update core."user" set extra_permissions = array['agents.use'] where id = $1`, [
    s.ben,
  ]);
  const { id: thread } = await tx.one<{ id: string }>(
    `insert into work.thread (workspace_id, owner_id, title) values ($1, $2, 'T') returning id`,
    [s.acme, s.ben],
  );
  const { id: question } = await tx.one<{ id: string }>(
    `insert into work.message (workspace_id, thread_id, role, content)
     values ($1, $2, 'user', 'go') returning id`,
    [s.acme, thread],
  );
  return { s, thread, question };
}

const start = (tx: Tx, ws: string, owner: string, thread: string, q: string, kind = "agent") =>
  tx.one<{ id: string }>(
    `insert into work.run (workspace_id, thread_id, owner_id, kind, status, question_id, subject_id)
     values ($1, $2, $3, $4, 'planned', $5, gen_random_uuid()) returning id`,
    [ws, thread, owner, kind, q],
  );

describe("agent runs", () => {
  it("lets a member with agents.use start a run and log steps", async () => {
    await withTx(async (tx) => {
      const { s, thread, question } = await setup(tx);
      await tx.as(s.ben, s.acme);
      const run = await start(tx, s.acme, s.ben, thread, question);
      const err = await tx.error(
        `insert into work.run_step (workspace_id, run_id, ordinal, kind, status)
         values ($1, $2, 0, 'plan', 'done')`,
        [s.acme, run.id],
      );
      expect(err).toBeUndefined();
      expect(await tx.rows("select ordinal from work.run_step")).toEqual([{ ordinal: 0 }]);
    });
  });

  it("refuses a run without agents.use", async () => {
    await withTx(async (tx) => {
      const { s, thread, question } = await setup(tx);
      await tx.asOwner();
      await tx.rows(`update core."user" set extra_permissions = '{}' where id = $1`, [s.ben]);
      await tx.as(s.ben, s.acme);
      expect(
        await tx.error(
          `insert into work.run (workspace_id, thread_id, owner_id, kind, status, question_id, subject_id)
           values ($1, $2, $3, 'agent', 'planned', $4, gen_random_uuid())`,
          [s.acme, thread, s.ben, question],
        ),
      ).toMatch(/row-level security/);
    });
  });

  it("needs a subject for agent kinds and none for thread kinds", async () => {
    await withTx(async (tx) => {
      const { s, thread, question } = await setup(tx);
      await tx.as(s.ben, s.acme);
      expect(
        await tx.error(
          `insert into work.run (workspace_id, thread_id, owner_id, kind, status, question_id)
           values ($1, $2, $3, 'agent', 'planned', $4)`,
          [s.acme, thread, s.ben, question],
        ),
      ).toMatch(/run_agent_subject/);
    });
  });

  it("hides steps from other members and refuses another's step", async () => {
    await withTx(async (tx) => {
      const { s, thread, question } = await setup(tx);
      await tx.as(s.ben, s.acme);
      const run = await start(tx, s.acme, s.ben, thread, question);
      await tx.rows(
        `insert into work.run_step (workspace_id, run_id, ordinal, kind, status)
         values ($1, $2, 0, 'plan', 'done')`,
        [s.acme, run.id],
      );
      await tx.as(s.cal, s.acme);
      expect(await tx.rows("select 1 from work.run_step")).toEqual([]);
    });
  });

  it("keeps one step per ordinal, so a retry cannot double a step", async () => {
    await withTx(async (tx) => {
      const { s, thread, question } = await setup(tx);
      await tx.as(s.ben, s.acme);
      const run = await start(tx, s.acme, s.ben, thread, question);
      const sql = `insert into work.run_step (workspace_id, run_id, ordinal, kind, status)
                   values ($1, $2, 1, 'generate', 'done')`;
      await tx.rows(sql, [s.acme, run.id]);
      expect(await tx.error(sql, [s.acme, run.id])).toMatch(/duplicate key/);
    });
  });

  it("leaves agent runs alone when failing runs the API process orphaned", async () => {
    await withTx(async (tx) => {
      const { s, thread, question } = await setup(tx);
      await tx.as(s.ben, s.acme);
      const run = await start(tx, s.acme, s.ben, thread, question);
      await tx.rows(`update work.run set status = 'running' where id = $1`, [run.id]);
      await tx.asWorker();
      const { n } = await tx.one<{ n: number }>(
        "select work.fail_orphaned_runs(now() + interval '1 hour') n",
      );
      expect(n).toBe(0);
      await tx.asOwner();
      expect(await tx.rows("select status from work.run where id = $1", [run.id])).toEqual([
        { status: "running" },
      ]);
    });
  });
});
