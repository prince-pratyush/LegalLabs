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
        "dee@acme.test",
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

  it("gives guests and service accounts no role or extra permissions", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      expect(
        await tx.error(`update core."user" set extra_permissions = '{admin.users}' where id = $1`, [
          s.gia,
        ]),
      ).toMatch(/check constraint/);
      expect(
        await tx.error(`update core."user" set role_id = $1 where id = $2`, [
          s.roles.acmeUser,
          s.gia,
        ]),
      ).toMatch(/check constraint/);
    });
  });

  it("does not let anyone change their own access", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.dee, s.acme);
      expect(
        await tx.error(`update core."user" set role_id = $1 where id = $2`, [
          s.roles.acmeAdmin,
          s.dee,
        ]),
      ).toMatch(/own access/);
      expect(
        await tx.error(`update core."user" set extra_permissions = '{}' where id = $1`, [s.dee]),
      ).toMatch(/own access/);
    });
  });

  it("does not let admin.users grant permissions it does not hold", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.dee, s.acme);
      expect(
        await tx.error(`update core."user" set role_id = $1 where id = $2`, [
          s.roles.acmeAdmin,
          s.ben,
        ]),
      ).toMatch(/do not hold/);
      expect(
        await tx.error(
          `update core."user" set extra_permissions = '{admin.matters}' where id = $1`,
          [s.ben],
        ),
      ).toMatch(/do not hold/);
      expect(
        await tx.error(`update core.role set permissions = '{*}' where id = $1`, [
          s.roles.acmeUser,
        ]),
      ).toMatch(/do not hold/);
      expect(
        await tx.error(`update core."user" set extra_permissions = '{admin.users}' where id = $1`, [
          s.ben,
        ]),
      ).toBeUndefined();
    });
  });

  it("does not let a guest be turned into a member", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ana, s.acme);
      expect(
        await tx.error(`update core."user" set kind = 'member' where id = $1`, [s.gia]),
      ).toMatch(/kind cannot change/);
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
