import { describe, expect, it } from "vitest";
import { type Tx, withTx } from "./db.js";
import { seed } from "./fixtures.js";

async function hasAccess(
  tx: Tx,
  user: string | null,
  ws: string | null,
  object: string,
  level: string,
) {
  await tx.as(user, ws);
  const { allowed } = await tx.one<{ allowed: boolean }>(
    "select core.has_access('thread', $1, $2) as allowed",
    [object, level],
  );
  await tx.asOwner();
  return allowed;
}

const grant = `insert into core.share_grant
  (workspace_id, object_type, object_id, principal_type, principal_id, level, granted_by, expires_at, suspended_reason)
  values ($1, 'thread', $2, $3, $4, $5, $6, $7, $8)`;

// Threads are shared only through work.share_thread, so direct writes use a vault.
const vaultGrant = grant.replace("'thread'", "'vault'");

describe("has_access", () => {
  it("gives a group's members the level shared with the group, and no higher", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      expect(await hasAccess(tx, s.ben, s.acme, s.objects.t1, "view")).toBe(true);
      expect(await hasAccess(tx, s.ben, s.acme, s.objects.t1, "edit")).toBe(false);
    });
  });

  it("treats a higher level as including the lower ones", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      expect(await hasAccess(tx, s.cal, s.acme, s.objects.t1, "view")).toBe(true);
      expect(await hasAccess(tx, s.cal, s.acme, s.objects.t1, "run")).toBe(true);
      expect(await hasAccess(tx, s.cal, s.acme, s.objects.t1, "edit")).toBe(true);
      expect(await hasAccess(tx, s.cal, s.acme, s.objects.t1, "full")).toBe(false);
    });
  });

  it("ignores expired and suspended grants", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const t2 = (await tx.one<{ id: string }>("select core.uuid7() as id")).id;
      const t3 = (await tx.one<{ id: string }>("select core.uuid7() as id")).id;
      await tx.rows(grant, [s.acme, t2, "user", s.ben, "view", s.ana, "2020-01-01", null]);
      await tx.rows(grant, [s.acme, t3, "user", s.ben, "view", s.ana, null, "wall"]);
      expect(await hasAccess(tx, s.ben, s.acme, t2, "view")).toBe(false);
      expect(await hasAccess(tx, s.ben, s.acme, t3, "view")).toBe(false);
    });
  });

  it("gives a workspace-wide share to members but not to guests or other workspaces", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const t4 = (await tx.one<{ id: string }>("select core.uuid7() as id")).id;
      await tx.rows(grant, [s.acme, t4, "workspace", s.acme, "view", s.ana, null, null]);
      expect(await hasAccess(tx, s.cal, s.acme, t4, "view")).toBe(true);
      expect(await hasAccess(tx, s.gia, s.acme, t4, "view")).toBe(false);
      expect(await hasAccess(tx, s.bob, s.beta, t4, "view")).toBe(false);
    });
  });

  it("denies everything when the request sets no user or a suspended one", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      expect(await hasAccess(tx, null, null, s.objects.t1, "view")).toBe(false);
      expect(await hasAccess(tx, s.sue, s.acme, s.objects.t1, "view")).toBe(false);
    });
  });

  it("denies an unknown level rather than guessing", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      expect(await hasAccess(tx, s.cal, s.acme, s.objects.t1, "owner")).toBe(false);
    });
  });
});

describe("share_grant under row-level security", () => {
  it("shows people the grants they made or received, not other people's", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ben, s.acme);
      const ben = await tx.rows("select principal_type from core.share_grant");
      expect(ben).toEqual([{ principal_type: "group" }]);
      await tx.as(s.ana, s.acme);
      expect(await tx.rows("select id from core.share_grant")).toHaveLength(2);
    });
  });

  it("records the person sharing as themselves only", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ben, s.acme);
      const t5 = (await tx.one<{ id: string }>("select core.uuid7() as id")).id;
      expect(
        await tx.error(vaultGrant, [s.acme, t5, "user", s.cal, "view", s.ana, null, null]),
      ).toMatch(/row-level security/);
      expect(
        await tx.error(vaultGrant, [s.acme, t5, "user", s.cal, "view", s.ben, null, null]),
      ).toBeUndefined();
    });
  });

  it("refuses a share to someone in another workspace", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      expect(
        await tx.error(grant, [s.acme, s.objects.t1, "user", s.bob, "view", s.ana, null, null]),
      ).toMatch(/not in this workspace/);
      expect(
        await tx.error(grant, [
          s.acme,
          s.objects.t1,
          "workspace",
          s.beta,
          "view",
          s.ana,
          null,
          null,
        ]),
      ).toMatch(/not in this workspace/);
    });
  });

  it("refuses a share to a space until spaces exist", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      expect(
        await tx.error(grant, [s.acme, s.objects.t1, "space", s.acme, "view", s.ana, null, null]),
      ).toMatch(/not in this workspace/);
    });
  });
});
