import { describe, expect, it } from "vitest";
import { type Tx, withTx } from "./db.js";
import { seed } from "./fixtures.js";

const lookup = "select * from core.find_login_credential($1, $2)";

async function givePassword(tx: Tx, workspaceId: string, userId: string): Promise<void> {
  await tx.asOwner();
  await tx.rows(
    "insert into core.password_credential (workspace_id, user_id, password_hash) values ($1, $2, 'stored-hash')",
    [workspaceId, userId],
  );
}

describe("password hashes", () => {
  it("cannot be read or written by the app, even by an admin", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await givePassword(tx, s.acme, s.ana);
      await tx.as(s.ana, s.acme);
      expect(await tx.error("select * from core.password_credential")).toMatch(/permission denied/);
      expect(await tx.error("update core.password_credential set password_hash = 'x'")).toMatch(
        /permission denied/,
      );
    });
  });

  it("are found before login by workspace and email, ignoring case", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await givePassword(tx, s.acme, s.ana);
      await tx.as(null, null);
      expect(await tx.rows(lookup, [s.slugs.acme, "ANA@acme.test"])).toEqual([
        { workspace_id: s.acme, user_id: s.ana, status: "active", password_hash: "stored-hash" },
      ]);
    });
  });

  it("report the workspace for an unknown email, so the failure can be audited", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(null, null);
      expect(await tx.rows(lookup, [s.slugs.acme, "nobody@acme.test"])).toEqual([
        { workspace_id: s.acme, user_id: null, status: null, password_hash: null },
      ]);
    });
  });

  it("find nothing for an unknown workspace", async () => {
    await withTx(async (tx) => {
      await tx.as(null, null);
      expect(await tx.rows(lookup, ["no-such-workspace", "ana@acme.test"])).toEqual([]);
    });
  });

  it("are only offered for members, not guests", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await givePassword(tx, s.acme, s.gia);
      await tx.as(null, null);
      expect(await tx.rows(lookup, [s.slugs.acme, "gia@guest.test"])).toEqual([
        { workspace_id: s.acme, user_id: null, status: null, password_hash: null },
      ]);
    });
  });

  it("are not shown for another workspace's slug", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await givePassword(tx, s.beta, s.bob);
      await tx.as(null, null);
      expect(await tx.rows(lookup, [s.slugs.acme, "bob@beta.test"])).toEqual([
        { workspace_id: s.acme, user_id: null, status: null, password_hash: null },
      ]);
    });
  });
});
