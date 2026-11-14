import { describe, expect, it } from "vitest";
import { type Tx, withTx } from "./db.js";
import { seed } from "./fixtures.js";

// A thread with a question, owned by `owner`, made as the table owner.
async function addThread(tx: Tx, ws: string, owner: string) {
  await tx.asOwner();
  const { id: threadId } = await tx.one<{ id: string }>(
    `insert into work.thread (workspace_id, owner_id, title) values ($1, $2, 'Q') returning id`,
    [ws, owner],
  );
  const { id: questionId } = await tx.one<{ id: string }>(
    `insert into work.message (workspace_id, thread_id, role, content)
     values ($1, $2, 'user', 'Q') returning id`,
    [ws, threadId],
  );
  return { threadId, questionId };
}

const startRun = (tx: Tx, ws: string, owner: string, thread: string, question: string) =>
  tx.one<{ id: string }>(
    `insert into work.run (workspace_id, thread_id, owner_id, kind, status, question_id)
     values ($1, $2, $3, 'thread', 'running', $4) returning id`,
    [ws, thread, owner, question],
  );

const addEvent = (tx: Tx, ws: string, run: string, seq: number) =>
  tx.error(
    `insert into work.run_event (workspace_id, run_id, seq, type, data)
     values ($1, $2, $3, 'status', '{"status":"running"}')`,
    [ws, run, seq],
  );

describe("runs", () => {
  it("lets the owner start a run and record its events", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const { threadId, questionId } = await addThread(tx, s.acme, s.ben);
      await tx.as(s.ben, s.acme);
      const run = await startRun(tx, s.acme, s.ben, threadId, questionId);
      expect(await addEvent(tx, s.acme, run.id, 1)).toBeUndefined();
      expect(await tx.rows("select seq from work.run_event")).toEqual([{ seq: 1 }]);
    });
  });

  it("hides runs and events from other members", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const { threadId, questionId } = await addThread(tx, s.acme, s.ben);
      await tx.as(s.ben, s.acme);
      const run = await startRun(tx, s.acme, s.ben, threadId, questionId);
      await addEvent(tx, s.acme, run.id, 1);
      await tx.as(s.cal, s.acme);
      expect(await tx.rows("select id from work.run")).toEqual([]);
      expect(await tx.rows("select seq from work.run_event")).toEqual([]);
    });
  });

  it("refuses a run or an event in someone else's name", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const { threadId, questionId } = await addThread(tx, s.acme, s.ben);
      await tx.as(s.cal, s.acme);
      expect(
        await tx.error(
          `insert into work.run (workspace_id, thread_id, owner_id, kind, status, question_id)
           values ($1, $2, $3, 'thread', 'running', $4)`,
          [s.acme, threadId, s.cal, questionId],
        ),
      ).toMatch(/row-level security/);
      await tx.as(s.ben, s.acme);
      const run = await startRun(tx, s.acme, s.ben, threadId, questionId);
      await tx.as(s.cal, s.acme);
      expect(await addEvent(tx, s.acme, run.id, 1)).toMatch(/row-level security/);
    });
  });

  it("lets only the owner change a run's status", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const { threadId, questionId } = await addThread(tx, s.acme, s.ben);
      await tx.as(s.ben, s.acme);
      const run = await startRun(tx, s.acme, s.ben, threadId, questionId);
      await tx.as(s.cal, s.acme);
      await tx.rows("update work.run set status = 'cancelled' where id = $1", [run.id]);
      await tx.as(s.ben, s.acme);
      expect(await tx.rows("select status from work.run")).toEqual([{ status: "running" }]);
      await tx.rows("update work.run set status = 'done' where id = $1", [run.id]);
      expect(await tx.rows("select status from work.run")).toEqual([{ status: "done" }]);
    });
  });
});

describe("authority citations", () => {
  const cite = (tx: Tx, ws: string, message: string, extra: string) =>
    tx.error(
      `insert into work.citation (workspace_id, message_id, ordinal, anchor, status, quote, ${extra}`,
      [ws, message],
    );

  it("is verified without a document, but a document citation still needs its place", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const { questionId } = await addThread(tx, s.acme, s.ben);
      await tx.asOwner();
      expect(
        await cite(
          tx,
          s.acme,
          questionId,
          "kind, authority_id) values ($1, $2, 0, 1, 'ok', 'held', 'authority', 'cl:1')",
        ),
      ).toBeUndefined();
      expect(
        await cite(tx, s.acme, questionId, "kind) values ($1, $2, 1, 1, 'ok', 'held', 'document')"),
      ).toMatch(/citation_ok_located/);
    });
  });
});

describe("favourites", () => {
  it("are each person's own", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const { threadId } = await addThread(tx, s.acme, s.ben);
      await tx.as(s.ben, s.acme);
      expect(
        await tx.error(
          "insert into work.thread_favourite (workspace_id, thread_id, user_id) values ($1, $2, $3)",
          [s.acme, threadId, s.ben],
        ),
      ).toBeUndefined();
      await tx.as(s.cal, s.acme);
      expect(await tx.rows("select thread_id from work.thread_favourite")).toEqual([]);
      expect(
        await tx.error(
          "insert into work.thread_favourite (workspace_id, thread_id, user_id) values ($1, $2, $3)",
          [s.acme, threadId, s.ben],
        ),
      ).toMatch(/row-level security/);
    });
  });
});

describe("orphaned runs", () => {
  it("are failed at startup by the worker, and nobody else can call it", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const { threadId, questionId } = await addThread(tx, s.acme, s.ben);
      await tx.as(s.ben, s.acme);
      const run = await startRun(tx, s.acme, s.ben, threadId, questionId);
      expect(await tx.error("select work.fail_orphaned_runs(now() + interval '1 minute')")).toMatch(
        /permission denied/,
      );
      await tx.asWorker();
      const { n } = await tx.one<{ n: number }>(
        "select work.fail_orphaned_runs(now() + interval '1 minute') n",
      );
      expect(n).toBeGreaterThanOrEqual(1);
      await tx.asOwner();
      expect(await tx.rows("select status from work.run where id = $1", [run.id])).toEqual([
        { status: "failed" },
      ]);
    });
  });
});
