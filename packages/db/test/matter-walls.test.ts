import { describe, expect, it } from "vitest";
import { type Tx, withTx } from "./db.js";
import { seed } from "./fixtures.js";

type Seeded = Awaited<ReturnType<typeof seed>>;

async function evaluate(tx: Tx, s: Seeded, user: string, matter: string | null) {
  await tx.as(s.ana, s.acme);
  const { result } = await tx.one<{ result: { allowed: boolean; reason: string } | null }>(
    "select core.evaluate_wall($1, $2) as result",
    [user, matter],
  );
  await tx.asOwner();
  return result;
}

async function canAccess(tx: Tx, user: string, ws: string, matter: string) {
  await tx.as(user, ws);
  const { allowed } = await tx.one<{ allowed: boolean }>(
    "select core.can_access_matter($1) as allowed",
    [matter],
  );
  await tx.asOwner();
  return allowed;
}

// A thread on M2 owned by Ana and shared with a group, as work.share_thread_groups would.
async function sharedThread(tx: Tx, s: Seeded, group: string) {
  const { id } = await tx.one<{ id: string }>(
    `insert into work.thread (workspace_id, owner_id, matter_id, title)
     values ($1, $2, $3, 'M2 thread') returning id`,
    [s.acme, s.ana, s.matters.m2],
  );
  const { id: grant } = await tx.one<{ id: string }>(
    `insert into core.share_grant
       (workspace_id, object_type, object_id, principal_type, principal_id, level, granted_by)
     values ($1, 'thread', $2, 'group', $3, 'view', $4) returning id`,
    [s.acme, id, group, s.ana],
  );
  return { thread: id, grant };
}

const suspended = async (tx: Tx, grant: string) =>
  (
    await tx.one<{ r: string | null }>(
      "select suspended_reason r from core.share_grant where id = $1",
      [grant],
    )
  ).r;

describe("core.evaluate_wall", () => {
  it("explains the worked examples with the same answer as can_access_matter", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const cases: [string, string, string][] = [
        [s.ana, s.matters.m1, "allowed"],
        [s.ben, s.matters.m1, "deny"],
        [s.cal, s.matters.m1, "not_allow_listed"],
        [s.ana, s.matters.m2, "open"],
        [s.cal, s.matters.m2, "deny"],
        [s.gia, s.matters.m2, "not_allow_listed"],
      ];
      for (const [user, matter, reason] of cases) {
        const result = await evaluate(tx, s, user, matter);
        expect(result?.reason).toBe(reason);
        expect(result?.allowed).toBe(await canAccess(tx, user, s.acme, matter));
      }
      expect((await evaluate(tx, s, s.cal, null))?.reason).toBe("no_matter");
    });
  });

  it("answers nothing to someone without admin.matters, or for another workspace", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ben, s.acme);
      expect(
        (await tx.one("select core.evaluate_wall($1, $2) r", [s.cal, s.matters.m1])).r,
      ).toBeNull();
      await tx.as(s.ana, s.acme);
      expect(
        (await tx.one("select core.evaluate_wall($1, $2) r", [s.bob, s.matters.mb])).r,
      ).toBeNull();
    });
  });
});

describe("require walls for sharing", () => {
  it("counts walled recipients only when the matter requires it", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const blocked = async () => {
        await tx.as(s.ana, s.acme);
        const { n } = await tx.one<{ n: number }>("select core.wall_share_blocked($1, $2) n", [
          s.matters.m2,
          JSON.stringify([
            { principal_type: "group", principal_id: s.groups.litTeam },
            { principal_type: "user", principal_id: s.ben },
          ]),
        ]);
        await tx.asOwner();
        return n;
      };
      expect(await blocked()).toBe(0);
      await tx.rows("update core.matter set require_walls_for_sharing = true where id = $1", [
        s.matters.m2,
      ]);
      expect(await blocked()).toBe(1);
    });
  });

  it("suspends a group grant when a member is walled, and reinstates it when lifted", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.rows("update core.matter set require_walls_for_sharing = true where id = $1", [
        s.matters.m2,
      ]);
      const { thread, grant } = await sharedThread(tx, s, s.groups.corpTeam);
      expect(await suspended(tx, grant)).toBeNull();

      await tx.as(s.ana, s.acme);
      const { id: wall } = await tx.one<{ id: string }>(
        `insert into core.wall (workspace_id, matter_id, principal_type, principal_id, effect)
         values ($1, $2, 'user', $3, 'deny') returning id`,
        [s.acme, s.matters.m2, s.ben],
      );
      await tx.asOwner();
      expect(await suspended(tx, grant)).toBe("wall");
      // A suspended grant gives Ben nothing, even before the wall would have hidden it.
      await tx.as(s.ben, s.acme);
      expect((await tx.one("select core.has_access('thread', $1, 'view') ok", [thread])).ok).toBe(
        false,
      );

      await tx.as(s.ana, s.acme);
      await tx.rows("delete from core.wall where id = $1", [wall]);
      await tx.asOwner();
      expect(await suspended(tx, grant)).toBeNull();
      const actions = await tx.rows<{ action: string }>(
        `select action from admin.audit_event where workspace_id = $1
            and action like 'wall.share_%' order by seq`,
        [s.acme],
      );
      expect(actions.map((a) => a.action)).toEqual([
        "wall.share_suspended",
        "wall.share_reinstated",
      ]);
    });
  });

  it("suspends a grant when a walled person joins the group", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.rows("update core.matter set require_walls_for_sharing = true where id = $1", [
        s.matters.m2,
      ]);
      const { grant } = await sharedThread(tx, s, s.groups.corpTeam);
      await tx.rows(
        "insert into core.group_member (workspace_id, group_id, user_id) values ($1, $2, $3)",
        [s.acme, s.groups.corpTeam, s.cal],
      );
      expect(await suspended(tx, grant)).toBe("wall");
      await tx.rows("delete from core.group_member where group_id = $1 and user_id = $2", [
        s.groups.corpTeam,
        s.cal,
      ]);
      expect(await suspended(tx, grant)).toBeNull();
    });
  });

  it("reinstates everything when the matter stops requiring walls", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const { grant } = await sharedThread(tx, s, s.groups.litTeam);
      expect(await suspended(tx, grant)).toBeNull();
      await tx.rows("update core.matter set require_walls_for_sharing = true where id = $1", [
        s.matters.m2,
      ]);
      expect(await suspended(tx, grant)).toBe("wall");
      await tx.rows("update core.matter set require_walls_for_sharing = false where id = $1", [
        s.matters.m2,
      ]);
      expect(await suspended(tx, grant)).toBeNull();
    });
  });
});

describe("matter options and own matters", () => {
  it("lets members read options and only admin.config write them", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const write = "update core.matter_options set user_editable = true returning workspace_id";
      await tx.as(s.ben, s.acme);
      expect(await tx.rows(write)).toEqual([]);
      await tx.as(s.ana, s.acme);
      expect(await tx.rows(write)).toEqual([{ workspace_id: s.acme }]);
      await tx.as(s.ben, s.acme);
      expect(await tx.rows("select user_editable from core.matter_options")).toEqual([
        { user_editable: true },
      ]);
    });
  });

  it("lets members create and edit their own matters only when user_editable", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const create = `insert into core.matter
        (id, workspace_id, client_id, client_name, matter_number, matter_name, created_by)
        values ($3, $1, 'C9', 'Own', 'X1', 'Own matter', $2)`;
      // No RETURNING: the wall check can't see a row inserted by the same statement.
      const { id } = await tx.one<{ id: string }>("select core.uuid7() id");
      await tx.as(s.ben, s.acme);
      expect(await tx.error(create, [s.acme, s.ben, id])).toMatch(/row-level security/);
      await tx.asOwner();
      await tx.rows(
        "update core.matter_options set user_editable = true where workspace_id = $1",
        [s.acme],
      );
      await tx.as(s.ben, s.acme);
      await tx.rows(create, [s.acme, s.ben, id]);
      await tx.rows("update core.matter set matter_name = 'Renamed' where id = $1", [id]);
      const changed = await tx.rows(
        "update core.matter set matter_name = 'No' where id = $1 returning id",
        [s.matters.m2],
      );
      expect(changed).toEqual([]);
    });
  });

  it("finds wall principals by email and group name for matters admins only", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ana, s.acme);
      const find = "select core.find_wall_principal($1, $2) id";
      expect((await tx.one(find, ["user", " CAL@acme.test "])).id).toBe(s.cal);
      expect((await tx.one(find, ["group", "Lit-Team"])).id).toBe(s.groups.litTeam);
      expect((await tx.one(find, ["user", "bob@beta.test"])).id).toBeNull();
      await tx.as(s.ben, s.acme);
      expect((await tx.one(find, ["user", "cal@acme.test"])).id).toBeNull();
    });
  });
});
