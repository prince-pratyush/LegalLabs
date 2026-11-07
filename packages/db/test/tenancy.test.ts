import { describe, expect, it } from "vitest";
import { withTx } from "./db.js";
import { seed } from "./fixtures.js";

describe("tenancy", () => {
  it("shows an active member their workspace and colleagues only", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ben, s.acme);
      const workspaces = await tx.rows("select id from core.workspace");
      expect(workspaces).toEqual([{ id: s.acme }]);
      const emails = await tx.rows<{ email: string }>(
        `select email from core."user" order by email`,
      );
      expect(emails.map((r) => r.email)).toEqual([
        "ana@acme.test",
        "ben@acme.test",
        "cal@acme.test",
        "gia@guest.test",
        "sue@acme.test",
      ]);
    });
  });

  it("shows a suspended member nothing", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.sue, s.acme);
      expect(await tx.rows(`select id from core."user"`)).toEqual([]);
    });
  });

  it("shows nothing when the user does not belong to the workspace in the request", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.bob, s.acme);
      expect(await tx.rows("select id from core.workspace")).toEqual([]);
      expect(await tx.rows(`select id from core."user"`)).toEqual([]);
    });
  });

  it("lets only admin.users add people", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const add = `insert into core."user" (workspace_id, email) values ($1, $2)`;
      await tx.as(s.ben, s.acme);
      expect(await tx.error(add, [s.acme, "new@acme.test"])).toMatch(/row-level security/);
      await tx.as(s.ana, s.acme);
      expect(await tx.error(add, [s.acme, "new@acme.test"])).toBeUndefined();
    });
  });

  it("does not let an admin add people to another workspace", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ana, s.acme);
      expect(
        await tx.error(`insert into core."user" (workspace_id, email) values ($1, $2)`, [
          s.beta,
          "spy@acme.test",
        ]),
      ).toMatch(/row-level security/);
    });
  });

  it("never grants admin permissions to a guest, even when listed", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.gia, s.acme);
      const { allowed } = await tx.one<{ allowed: boolean }>(
        "select core.has_permission('admin.users') as allowed",
      );
      expect(allowed).toBe(false);
    });
  });

  it("refuses a role from another workspace", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      expect(
        await tx.error(`update core."user" set role_id = $1 where id = $2`, [
          s.roles.betaAdmin,
          s.ben,
        ]),
      ).toMatch(/foreign key/);
    });
  });

  it("treats the same email in different case as one person", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      expect(
        await tx.error(
          `insert into core."user" (workspace_id, email) values ($1, 'BEN@acme.test')`,
          [s.acme],
        ),
      ).toMatch(/duplicate key/);
    });
  });
});
