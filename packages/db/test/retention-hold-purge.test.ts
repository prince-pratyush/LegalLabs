import { describe, expect, it } from "vitest";
import { type Tx, withTx } from "./db.js";
import { seed } from "./fixtures.js";

type Seed = Awaited<ReturnType<typeof seed>>;

const hold = (tx: Tx, s: Seed, type: string, id: string) =>
  tx.rows(
    `insert into retention.hold (workspace_id, object_type, object_id, reason, set_by)
     values ($1, $2, $3, 'Dispute', $4)`,
    [s.acme, type, id, s.ana],
  );

const exists = async (tx: Tx, table: string, id: string) =>
  (await tx.rows(`select 1 from ${table} where id = $1`, [id])).length === 1;

/** The seeded vault, or its folder and file, binned 40 days ago. */
async function binned(tx: Tx, what: "folder" | "vault") {
  const s = await seed(tx);
  const v = s.vaults.acme;
  await tx.asOwner();
  const table = what === "vault" ? "content.vault" : "content.folder";
  await tx.rows(
    `update ${table} set deleted_at = now() - interval '40 days', deleted_by = $2 where id = $1`,
    [what === "vault" ? v.vaultId : v.folderId, s.ana],
  );
  if (what === "folder") {
    await tx.rows(
      `update content.document set deleted_at = now() - interval '40 days', deleted_by = $2,
              deleted_reason = 'user'
        where id = $1`,
      [v.documentId, s.ana],
    );
  }
  return { s, v };
}

const purge = (tx: Tx) => tx.rows("select 1 from content.purge_expired_bin(30)");

describe("legal holds against the vault bin (F-39)", () => {
  for (const type of ["document", "vault"] as const) {
    it(`keeps a binned folder while a ${type} hold covers its file`, async () => {
      await withTx(async (tx) => {
        const { s, v } = await binned(tx, "folder");
        await hold(tx, s, type, type === "vault" ? v.vaultId : v.documentId);
        await purge(tx);
        expect(await exists(tx, "content.document", v.documentId)).toBe(true);
        expect(await exists(tx, "content.folder", v.folderId)).toBe(true);
      });
    });
  }

  it("keeps a binned vault holding a held file, and refuses an admin's purge", async () => {
    await withTx(async (tx) => {
      const { s, v } = await binned(tx, "vault");
      await hold(tx, s, "document", v.documentId);
      await purge(tx);
      expect(await exists(tx, "content.document", v.documentId)).toBe(true);
      expect(await exists(tx, "content.vault", v.vaultId)).toBe(true);
      await tx.as(s.ana, s.acme);
      expect(await tx.error("select content.purge_vault($1)", [v.vaultId])).toMatch(/HELD/);
    });
  });

  it("keeps a binned vault whose matter is held", async () => {
    await withTx(async (tx) => {
      const { s, v } = await binned(tx, "vault");
      await tx.rows("update content.vault set matter_id = $2 where id = $1", [
        v.vaultId,
        s.matters.m2,
      ]);
      await hold(tx, s, "matter", s.matters.m2);
      await purge(tx);
      expect(await exists(tx, "content.vault", v.vaultId)).toBe(true);
      expect(await exists(tx, "content.document", v.documentId)).toBe(true);
    });
  });

  it("does not let purging a parent file take a held child with it", async () => {
    await withTx(async (tx) => {
      const { s, v } = await binned(tx, "folder");
      const child = s.documents.acme.documentId;
      await tx.rows("update content.document set parent_id = $2 where id = $1", [
        child,
        v.documentId,
      ]);
      await hold(tx, s, "document", child);
      await purge(tx);
      expect(await exists(tx, "content.document", child)).toBe(true);
    });
  });

  it("still purges what no hold covers", async () => {
    await withTx(async (tx) => {
      const { v } = await binned(tx, "vault");
      await purge(tx);
      expect(await exists(tx, "content.vault", v.vaultId)).toBe(false);
    });
  });
});
