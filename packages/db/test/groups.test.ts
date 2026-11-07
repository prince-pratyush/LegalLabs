import { describe, expect, it } from "vitest";
import { withTx } from "./db.js";
import { seed } from "./fixtures.js";

describe("groups", () => {
  it("shows a member public groups and private groups they belong to", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ben, s.acme);
      const names = await tx.rows<{ name: string }>(`select name from core."group" order by name`);
      expect(names.map((r) => r.name)).toEqual(["corp-team", "everyone"]);
    });
  });

  it("shows an admin every group", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ana, s.acme);
      const names = await tx.rows<{ name: string }>(`select name from core."group" order by name`);
      expect(names.map((r) => r.name)).toEqual(["corp-team", "everyone", "lit-team", "party-p"]);
    });
  });

  it("shows fellow members but not the members of other private groups", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ben, s.acme);
      const members = await tx.rows<{ user_id: string }>(
        "select user_id from core.group_member order by user_id",
      );
      expect(members.map((r) => r.user_id).sort()).toEqual([s.ana, s.ben].sort());
    });
  });

  it("lets only admin.users change membership", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const add =
        "insert into core.group_member (workspace_id, group_id, user_id) values ($1, $2, $3)";
      await tx.as(s.ben, s.acme);
      expect(await tx.error(add, [s.acme, s.groups.corpTeam, s.cal])).toMatch(/row-level security/);
      await tx.as(s.ana, s.acme);
      expect(await tx.error(add, [s.acme, s.groups.corpTeam, s.cal])).toBeUndefined();
    });
  });

  it("refuses a member from another workspace", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const add =
        "insert into core.group_member (workspace_id, group_id, user_id) values ($1, $2, $3)";
      expect(await tx.error(add, [s.acme, s.groups.corpTeam, s.bob])).toMatch(/foreign key/);
    });
  });
});
