import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { type Tx, withTx } from "./db.js";
import { type Seed, seed } from "./fixtures.js";

/*
 * Pen-test P-02 (CON-002): a synced vault is a read-only mirror of someone's Drive. People must
 * not be able to edit what the sync wrote, and a vault must run only on its owner's connection.
 */

// A vault of Ana's that mirrors a Drive folder over the given person's connection, with one file
// the sync wrote.
async function syncedVault(tx: Tx, s: Seed, connectionOwner: string = s.ana) {
  await tx.asOwner();
  const ref = `sec_${randomUUID().replaceAll("-", "")}`;
  await tx.rows(
    "insert into admin.secret (id, workspace_id, ciphertext) values ($1, $2, decode(repeat('00', 40), 'hex'))",
    [ref, s.acme],
  );
  const conn = await tx.one<{ id: string }>(
    `insert into content.sync_connection (workspace_id, user_id, provider, secret_ref)
     values ($1, $2, 'google_drive', $3) returning id`,
    [s.acme, connectionOwner, ref],
  );
  const vault = await tx.one<{ id: string }>(
    "insert into content.vault (workspace_id, owner_id, name) values ($1, $2, 'Mirror') returning id",
    [s.acme, s.ana],
  );
  await tx.rows(
    `insert into content.vault_sync (vault_id, workspace_id, connection_id, provider, root_remote_id)
     values ($1, $2, $3, 'google_drive', 'root')`,
    [vault.id, s.acme, conn.id],
  );
  // The sync's own write goes through the engine's session setting.
  await tx.rows("select set_config('legallabs.sync_writer', 'on', true)");
  const doc = await tx.one<{ id: string }>(
    `insert into content.document (workspace_id, owner_id, name, mime, size, vault_id)
     values ($1, $2, 'mirrored.pdf', 'application/pdf', 10, $3) returning id`,
    [s.acme, s.ana, vault.id],
  );
  await tx.rows("select set_config('legallabs.sync_writer', 'off', true)");
  return { vaultId: vault.id, documentId: doc.id, connectionId: conn.id };
}

describe("P-02 the synced vault is read-only", () => {
  it("refuses a rename, a bin and a new file by the vault's own owner", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const v = await syncedVault(tx, s);
      await tx.as(s.ana, s.acme);
      expect(
        await tx.error("update content.document set name = 'edited' where id = $1", [v.documentId]),
      ).toContain("VAULT_READ_ONLY");
      expect(
        await tx.error("select content.trash_items($1, array[$2]::uuid[], '{}')", [
          v.vaultId,
          v.documentId,
        ]),
      ).toContain("VAULT_READ_ONLY");
      expect(
        await tx.error(
          `insert into content.document (workspace_id, owner_id, name, mime, size, vault_id)
           values ($1, $2, 'planted.pdf', 'application/pdf', 1, $3)`,
          [s.acme, s.ana, v.vaultId],
        ),
      ).toContain("VAULT_READ_ONLY");
    });
  });

  it("cannot delete a mirrored row or move it out of the vault", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const v = await syncedVault(tx, s);
      await tx.as(s.ana, s.acme);
      expect(await tx.error("delete from content.document where id = $1", [v.documentId])).toMatch(
        /permission denied|VAULT_READ_ONLY/,
      );
      expect(
        await tx.error("update content.document set vault_id = null where id = $1", [v.documentId]),
      ).toMatch(/permission denied|VAULT_READ_ONLY/);
    });
  });

  it("will not link a vault to another person's connection", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      // Ben's connection; Ana points her own vault at it to read his Drive.
      const theirs = await syncedVault(tx, s, s.ben);
      await tx.asOwner();
      const mine = await tx.one<{ id: string }>(
        "insert into content.vault (workspace_id, owner_id, name) values ($1, $2, 'Grab') returning id",
        [s.acme, s.ana],
      );
      await tx.as(s.ana, s.acme);
      const err = await tx.error(
        `insert into content.vault_sync (vault_id, workspace_id, connection_id, provider, root_remote_id)
         values ($1, $2, $3, 'google_drive', 'their-secret-folder')`,
        [mine.id, s.acme, theirs.connectionId],
      );
      expect(err).toContain("that connection is not yours");
    });
  });

  it("will not swap a running sync onto another person's connection", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const mine = await syncedVault(tx, s);
      const theirs = await syncedVault(tx, s, s.ben);
      await tx.as(s.ana, s.acme);
      const err = await tx.error(
        "update content.vault_sync set connection_id = $2 where vault_id = $1",
        [mine.vaultId, theirs.connectionId],
      );
      expect(err).toContain("keeps its connection");
    });
  });

  it("still lets the owner link their own connection and the engine update status", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const v = await syncedVault(tx, s);
      await tx.as(s.ana, s.acme);
      await tx.rows("select set_config('legallabs.sync_writer', 'on', true)");
      expect(
        await tx.error(
          "update content.vault_sync set status = 'ok', change_token = 'x' where vault_id = $1",
          [v.vaultId],
        ),
      ).toBeUndefined();
      await tx.asOwner();
      const own = await tx.one<{ id: string }>(
        "insert into content.vault (workspace_id, owner_id, name) values ($1, $2, 'Second') returning id",
        [s.acme, s.ana],
      );
      await tx.as(s.ana, s.acme);
      expect(
        await tx.error(
          `insert into content.vault_sync (vault_id, workspace_id, connection_id, provider, root_remote_id)
           values ($1, $2, $3, 'google_drive', 'folder')`,
          [own.id, s.acme, v.connectionId],
        ),
      ).toBeUndefined();
    });
  });
});
