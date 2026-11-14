import { describe, expect, it } from "vitest";
import { type Tx, withTx } from "./db.js";
import { seed } from "./fixtures.js";

async function threadOf(tx: Tx, ws: string, owner: string, matter: string | null) {
  await tx.asOwner();
  const { id } = await tx.one<{ id: string }>(
    `insert into work.thread (workspace_id, owner_id, matter_id, title)
     values ($1, $2, $3, 'Q') returning id`,
    [ws, owner, matter],
  );
  await tx.rows(
    `insert into work.message (workspace_id, thread_id, role, content) values ($1, $2, 'user', 'Q')`,
    [ws, id],
  );
  return id;
}

const share = (tx: Tx, thread: string, users: string[], link = false) =>
  tx.rows<{ principal_id: string; outcome: string }>(
    "select principal_id, outcome from work.share_thread($1, $2::uuid[], $3)",
    [thread, users, link],
  );

const sees = async (tx: Tx, user: string, ws: string, thread: string) => {
  await tx.as(user, ws);
  return (await tx.rows("select id from work.thread where id = $1", [thread])).length === 1;
};

describe("sharing a thread", () => {
  it("can't be done by writing a grant directly", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const thread = await threadOf(tx, s.acme, s.ana, null);
      await tx.as(s.ben, s.acme);
      expect(
        await tx.error(
          `insert into core.share_grant (workspace_id, object_type, object_id, principal_type,
                                         principal_id, level, granted_by)
           values ($1, 'thread', $2, 'user', $3, 'view', $3)`,
          [s.acme, thread, s.ben],
        ),
      ).toMatch(/row-level security/);
    });
  });

  it("lets a recipient read it but not add to it", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const thread = await threadOf(tx, s.acme, s.ana, null);
      await tx.as(s.ana, s.acme);
      expect(await share(tx, thread, [s.ben])).toEqual([
        { principal_id: s.ben, outcome: "created" },
      ]);
      expect(await sees(tx, s.ben, s.acme, thread)).toBe(true);
      expect(await tx.rows("select role from work.message")).toEqual([{ role: "user" }]);
      expect(
        await tx.error(
          `insert into work.message (workspace_id, thread_id, role, content) values ($1, $2, 'user', 'x')`,
          [s.acme, thread],
        ),
      ).toMatch(/row-level security/);
    });
  });

  it("checks each recipient against the thread's wall", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      // M1 is allow-listed to corp-team, which has Ana and Ben, but Ben is also denied.
      const thread = await threadOf(tx, s.acme, s.ana, s.matters.m1);
      await tx.as(s.ana, s.acme);
      expect(await share(tx, thread, [s.ben, s.cal, s.gia])).toEqual([
        { principal_id: s.ben, outcome: "WALL_DENIED" },
        { principal_id: s.cal, outcome: "WALL_DENIED" },
        { principal_id: s.gia, outcome: "NOT_MEMBER" },
      ]);
      expect(await sees(tx, s.cal, s.acme, thread)).toBe(false);
    });
  });

  it("refuses a link share behind a wall, allows it otherwise", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const walled = await threadOf(tx, s.acme, s.ana, s.matters.m2);
      const open = await threadOf(tx, s.acme, s.ana, null);
      await tx.as(s.ana, s.acme);
      expect(await tx.error("select * from work.share_thread($1, '{}', true)", [walled])).toMatch(
        /WALL_MISMATCH/,
      );
      await share(tx, open, [], true);
      expect(await sees(tx, s.cal, s.acme, open)).toBe(true);
      expect(await sees(tx, s.gia, s.acme, open)).toBe(false);
    });
  });

  it("is the owner's alone to give and take back", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const thread = await threadOf(tx, s.acme, s.ana, null);
      await tx.as(s.ben, s.acme);
      expect(
        await tx.error("select * from work.share_thread($1, $2::uuid[], false)", [thread, [s.cal]]),
      ).toMatch(/thread not found/);
      await tx.as(s.ana, s.acme);
      await share(tx, thread, [s.cal]);
      const [grant] = await tx.rows<{ id: string; email: string }>(
        "select id, email from work.thread_shares($1)",
        [thread],
      );
      expect(grant?.email).toBe("cal@acme.test");
      await tx.as(s.ben, s.acme);
      expect(await tx.rows("select * from work.thread_shares($1)", [thread])).toEqual([]);
      expect(
        (
          await tx.one<{ ok: boolean }>("select work.revoke_thread_share($1, $2) ok", [
            thread,
            grant?.id,
          ])
        ).ok,
      ).toBe(false);
      await tx.as(s.ana, s.acme);
      expect(
        (
          await tx.one<{ ok: boolean }>("select work.revoke_thread_share($1, $2) ok", [
            thread,
            grant?.id,
          ])
        ).ok,
      ).toBe(true);
      expect(await sees(tx, s.cal, s.acme, thread)).toBe(false);
    });
  });
});
