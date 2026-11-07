import { describe, expect, it } from "vitest";
import { type Tx, withTx } from "./db.js";
import { seed } from "./fixtures.js";

async function canAccess(tx: Tx, user: string | null, ws: string | null, matter: string | null) {
  await tx.as(user, ws);
  const { allowed } = await tx.one<{ allowed: boolean }>(
    "select core.can_access_matter($1) as allowed",
    [matter],
  );
  await tx.asOwner();
  return allowed;
}

describe("can_access_matter, the worked examples", () => {
  it("allows Ana on M1 through her group's allow row", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      expect(await canAccess(tx, s.ana, s.acme, s.matters.m1)).toBe(true);
    });
  });

  it("denies Ben on M1, because deny beats his group's allow", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      expect(await canAccess(tx, s.ben, s.acme, s.matters.m1)).toBe(false);
    });
  });

  it("denies Cal on M1, because he is not on the allow-list", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      expect(await canAccess(tx, s.cal, s.acme, s.matters.m1)).toBe(false);
    });
  });

  it("allows Ana on open M2 and denies Cal, who has a deny row", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      expect(await canAccess(tx, s.ana, s.acme, s.matters.m2)).toBe(true);
      expect(await canAccess(tx, s.cal, s.acme, s.matters.m2)).toBe(false);
    });
  });

  it("lets a wall on a party group admit that party's guest", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      expect(await canAccess(tx, s.gia, s.acme, s.matters.m1)).toBe(false);
      await tx.rows(
        `insert into core.wall (workspace_id, matter_id, principal_type, principal_id, effect)
         values ($1, $2, 'group', $3, 'allow')`,
        [s.acme, s.matters.m1, s.groups.partyP],
      );
      expect(await canAccess(tx, s.gia, s.acme, s.matters.m1)).toBe(true);
    });
  });
});

describe("can_access_matter fails closed", () => {
  it("keeps guests and service accounts out of open matters without an allow row", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const svc = (
        await tx.one<{ id: string }>(
          `insert into core."user" (workspace_id, email, status, kind)
           values ($1, 'svc_sync@acme.test', 'active', 'service') returning id`,
          [s.acme],
        )
      ).id;
      expect(await canAccess(tx, s.gia, s.acme, s.matters.m2)).toBe(false);
      expect(await canAccess(tx, svc, s.acme, s.matters.m2)).toBe(false);
      await tx.rows(
        `insert into core.wall (workspace_id, matter_id, principal_type, principal_id, effect)
         values ($1, $2, 'user', $3, 'allow')`,
        [s.acme, s.matters.m2, svc],
      );
      expect(await canAccess(tx, svc, s.acme, s.matters.m2)).toBe(true);
    });
  });

  it("admits nobody to an allow-list matter with no allow rows, not even an admin", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      expect(await canAccess(tx, s.ana, s.acme, s.matters.m3)).toBe(false);
    });
  });

  it("closes M1 when its last allow row is removed, rather than opening it", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.rows("delete from core.wall where matter_id = $1 and effect = 'allow'", [
        s.matters.m1,
      ]);
      expect(await canAccess(tx, s.ana, s.acme, s.matters.m1)).toBe(false);
    });
  });

  it("denies everything when the request sets no user, even with no matter", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      expect(await canAccess(tx, null, null, null)).toBe(false);
      expect(await canAccess(tx, s.ana, s.acme, null)).toBe(true);
    });
  });

  it("denies a matter from another workspace", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      expect(await canAccess(tx, s.ana, s.acme, s.matters.mb)).toBe(false);
    });
  });

  it("denies a suspended member", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      expect(await canAccess(tx, s.sue, s.acme, s.matters.m2)).toBe(false);
    });
  });
});

describe("matters and walls under row-level security", () => {
  it("hides walled matters from the people they wall", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ben, s.acme);
      const ben = await tx.rows("select matter_number from core.matter order by 1");
      expect(ben).toEqual([{ matter_number: "M2" }]);
      await tx.as(s.cal, s.acme);
      expect(await tx.rows("select matter_number from core.matter")).toEqual([]);
    });
  });

  it("shows admin.matters every matter, including ones they are walled from", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ana, s.acme);
      const rows = await tx.rows("select matter_number from core.matter order by 1");
      expect(rows).toEqual([
        { matter_number: "M1" },
        { matter_number: "M2" },
        { matter_number: "M3" },
      ]);
    });
  });

  it("shows wall rows only to admin.matters", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ben, s.acme);
      expect(await tx.rows("select id from core.wall")).toEqual([]);
      await tx.as(s.ana, s.acme);
      expect(await tx.rows("select id from core.wall")).toHaveLength(3);
    });
  });

  it("refuses a wall on someone from another workspace", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      expect(
        await tx.error(
          `insert into core.wall (workspace_id, matter_id, principal_type, principal_id, effect)
           values ($1, $2, 'user', $3, 'deny')`,
          [s.acme, s.matters.m2, s.bob],
        ),
      ).toMatch(/not in this workspace/);
    });
  });

  it("refuses a group id given as a user", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      expect(
        await tx.error(
          `insert into core.wall (workspace_id, matter_id, principal_type, principal_id, effect)
           values ($1, $2, 'user', $3, 'deny')`,
          [s.acme, s.matters.m2, s.groups.corpTeam],
        ),
      ).toMatch(/not in this workspace/);
    });
  });

  it("lets a person acknowledge a notice only on a matter they can access", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const ack = `insert into core.matter_acknowledgement (workspace_id, user_id, matter_id, notice_version)
                   values ($1, $2, $3, 1)`;
      await tx.as(s.ben, s.acme);
      expect(await tx.error(ack, [s.acme, s.ben, s.matters.m2])).toBeUndefined();
      expect(await tx.error(ack, [s.acme, s.ben, s.matters.m1])).toMatch(/row-level security/);
      expect(await tx.error(ack, [s.acme, s.ana, s.matters.m2])).toMatch(/row-level security/);
    });
  });
});
