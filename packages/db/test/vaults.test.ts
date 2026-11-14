import { describe, expect, it } from "vitest";
import { type Tx, withTx } from "./db.js";
import { type Seed, seed } from "./fixtures.js";

const SHA = `\\x${"cd".repeat(32)}`;

// A searchable file in the fixture vault, inserted as the schema owner.
async function addFile(
  tx: Tx,
  s: Seed,
  matter: string | null,
  text: string,
  vault = s.vaults.acme.vaultId,
) {
  await tx.asOwner();
  const { id: documentId } = await tx.one<{ id: string }>(
    `insert into content.document (workspace_id, owner_id, matter_id, name, mime, size, vault_id)
     values ($1, $2, $3, 'file.txt', 'text/plain', 10, $4) returning id`,
    [s.acme, s.ana, matter, vault],
  );
  const { id: versionId } = await tx.one<{ id: string }>(
    `insert into content.document_version (workspace_id, document_id, sha256, page_count, created_by)
     values ($1, $2, $3, 1, $4) returning id`,
    [s.acme, documentId, SHA, s.ana],
  );
  await tx.rows(
    `insert into content.page (workspace_id, version_id, page_no, width, height, text, layout)
     values ($1, $2, 1, 612, 792, $3, '{"blocks":[]}')`,
    [s.acme, versionId, text],
  );
  await tx.rows(
    `insert into content.chunk (workspace_id, version_id, page_no, ordinal, char_from, char_to, text)
     values ($1, $2, 1, 0, 0, $3, $4)`,
    [s.acme, versionId, text.length, text],
  );
  return documentId;
}

const share = async (tx: Tx, s: Seed, grants: object[], vault = s.vaults.acme.vaultId) => {
  await tx.as(s.ana, s.acme);
  const { result } = await tx.one<{ result: { denied_by_wall: string[] } }>(
    "select content.set_vault_shares($1, $2, false) result",
    [vault, JSON.stringify(grants)],
  );
  return result.denied_by_wall;
};

const count = async (tx: Tx, sql: string, params: unknown[] = []) =>
  Number((await tx.one<{ n: string }>(`select count(*) n from ${sql}`, params)).n);

const vaultFiles = (tx: Tx, s: Seed) =>
  count(tx, "content.document where vault_id = $1", [s.vaults.acme.vaultId]);

describe("who can see a vault", () => {
  it("shows the owner everything and others nothing until it is shared", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ana, s.acme);
      expect(await vaultFiles(tx, s)).toBe(1);
      expect(await count(tx, "content.folder")).toBe(1);
      await tx.as(s.ben, s.acme);
      expect(await vaultFiles(tx, s)).toBe(0);
      expect(await count(tx, "content.vault")).toBe(0);
      expect(
        await share(tx, s, [{ principal_type: "user", principal_id: s.ben, level: "view" }]),
      ).toEqual([]);
      await tx.as(s.ben, s.acme);
      expect(await vaultFiles(tx, s)).toBe(1);
      expect(await count(tx, "content.folder")).toBe(1);
    });
  });

  it("reaches a group's members and the whole workspace", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await share(tx, s, [
        { principal_type: "group", principal_id: s.groups.litTeam, level: "view" },
      ]);
      await tx.as(s.cal, s.acme);
      expect(await vaultFiles(tx, s)).toBe(1);
      await tx.as(s.ana, s.acme);
      await tx.rows("select content.set_vault_shares($1, '[]', true)", [s.vaults.acme.vaultId]);
      await tx.as(s.ben, s.acme);
      expect(await vaultFiles(tx, s)).toBe(1);
      // Guests reach vaults only through a Space.
      await tx.as(s.gia, s.acme);
      expect(await vaultFiles(tx, s)).toBe(0);
    });
  });

  it("never shows another workspace's vault", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.bob, s.beta);
      expect(await vaultFiles(tx, s)).toBe(0);
      expect(await tx.error("select content.vault_usage($1)", [s.vaults.acme.vaultId])).toMatch(
        /not allowed/,
      );
    });
  });
});

describe("what each level may do", () => {
  const addFolder = (tx: Tx, s: Seed, user: string) =>
    tx.error(
      "insert into content.folder (workspace_id, vault_id, name, created_by) values ($1, $2, 'New', $3)",
      [s.acme, s.vaults.acme.vaultId, user],
    );

  it("lets view read but not change anything", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await share(tx, s, [{ principal_type: "user", principal_id: s.ben, level: "view" }]);
      await tx.as(s.ben, s.acme);
      expect(await addFolder(tx, s, s.ben)).toMatch(/row-level security/);
      await tx.rows("update content.document set name = 'x.txt' where id = $1", [
        s.vaults.acme.documentId,
      ]);
      await tx.as(s.ana, s.acme);
      expect(
        (
          await tx.one<{ name: string }>("select name from content.document where id = $1", [
            s.vaults.acme.documentId,
          ])
        ).name,
      ).toBe("nda.txt");
      await tx.as(s.ben, s.acme);
      expect(
        await tx.error("select content.trash_items($1, $2, '{}')", [
          s.vaults.acme.vaultId,
          [s.vaults.acme.documentId],
        ]),
      ).toMatch(/not allowed/);
      expect(
        await tx.error("select content.set_vault_shares($1, '[]', false)", [s.vaults.acme.vaultId]),
      ).toMatch(/not allowed/);
    });
  });

  it("lets edit add, rename and move, but not share", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await share(tx, s, [{ principal_type: "user", principal_id: s.ben, level: "edit" }]);
      await tx.as(s.ben, s.acme);
      expect(await addFolder(tx, s, s.ben)).toBeUndefined();
      await tx.rows("update content.document set name = 'x.txt', folder_id = null where id = $1", [
        s.vaults.acme.documentId,
      ]);
      expect(
        (
          await tx.one<{ name: string }>("select name from content.document where id = $1", [
            s.vaults.acme.documentId,
          ])
        ).name,
      ).toBe("x.txt");
      expect(
        await tx.error("select content.set_vault_shares($1, '[]', false)", [s.vaults.acme.vaultId]),
      ).toMatch(/not allowed/);
    });
  });

  it("lets a viewer add no text to a file others will cite", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const documentId = await addFile(tx, s, null, "Original clause.");
      await share(tx, s, [{ principal_type: "user", principal_id: s.ben, level: "view" }]);
      await tx.as(s.ben, s.acme);
      expect(
        await tx.error(
          `insert into content.document_version (workspace_id, document_id, sha256, created_by)
           values ($1, $2, $3, $4)`,
          [s.acme, documentId, SHA, s.ben],
        ),
      ).toMatch(/row-level security/);
      const { id: versionId } = await tx.one<{ id: string }>(
        "select id from content.document_version where document_id = $1",
        [documentId],
      );
      expect(
        await tx.error(
          `insert into content.chunk (workspace_id, version_id, page_no, ordinal, char_from, char_to, text)
           values ($1, $2, 1, 9, 0, 5, 'Fake.')`,
          [s.acme, versionId],
        ),
      ).toMatch(/row-level security|violates/);
    });
  });

  it("keeps a file out of a folder in the recycle bin", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const { vaultId, folderId } = s.vaults.acme;
      await tx.as(s.ana, s.acme);
      const { id: other } = await tx.one<{ id: string }>(
        "insert into content.folder (workspace_id, vault_id, name, created_by) values ($1, $2, 'Old', $3) returning id",
        [s.acme, vaultId, s.ana],
      );
      await tx.rows("select content.trash_items($1, '{}', $2)", [vaultId, [other]]);
      const doc = await addFile(tx, s, null, "Live file.");
      await tx.as(s.ana, s.acme);
      expect(
        await tx.error("update content.document set folder_id = $1 where id = $2", [other, doc]),
      ).toMatch(/row-level security/);
      expect(
        await tx.error("update content.document set folder_id = $1 where id = $2", [folderId, doc]),
      ).toBeUndefined();
    });
  });

  it("keeps a folder from moving inside itself", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ana, s.acme);
      const { id: child } = await tx.one<{ id: string }>(
        `insert into content.folder (workspace_id, vault_id, parent_id, name, created_by)
         values ($1, $2, $3, 'Child', $4) returning id`,
        [s.acme, s.vaults.acme.vaultId, s.vaults.acme.folderId, s.ana],
      );
      expect(
        await tx.error("update content.folder set parent_id = $1 where id = $2", [
          child,
          s.vaults.acme.folderId,
        ]),
      ).toMatch(/inside itself/);
    });
  });
});

describe("walls inside a vault", () => {
  it("hides a walled file and its text from someone the vault is shared with", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await addFile(tx, s, null, "Open clause on liability.");
      await addFile(tx, s, s.matters.m1, "Walled clause on liability.");
      await share(tx, s, [{ principal_type: "user", principal_id: s.ben, level: "view" }]);
      await tx.as(s.ben, s.acme);
      expect(await vaultFiles(tx, s)).toBe(2);
      const texts = await tx.rows<{ text: string }>(
        `select c.text from content.chunk c
           join content.document_version v on v.id = c.version_id
           join content.document d on d.id = v.document_id
          where d.vault_id = $1`,
        [s.vaults.acme.vaultId],
      );
      expect(texts.map((row) => row.text)).toEqual(["Open clause on liability."]);
      const usage = await tx.one<{ files: string; hidden: string }>(
        "select * from content.vault_usage($1)",
        [s.vaults.acme.vaultId],
      );
      expect({ files: Number(usage.files), hidden: Number(usage.hidden) }).toEqual({
        files: 3,
        hidden: 1,
      });
    });
  });

  it("refuses a walled person when a matter vault is shared, and lists walled group members", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ana, s.acme);
      const { id: vault } = await tx.one<{ id: string }>(
        "insert into content.vault (workspace_id, owner_id, matter_id, name) values ($1, $2, $3, 'M1') returning id",
        [s.acme, s.ana, s.matters.m1],
      );
      const denied = await share(
        tx,
        s,
        [
          { principal_type: "user", principal_id: s.ben, level: "view" },
          { principal_type: "group", principal_id: s.groups.corpTeam, level: "view" },
        ],
        vault,
      );
      expect(denied).toEqual([s.ben, s.ben]);
      const grants = await tx.rows<{ principal_id: string }>(
        "select principal_id from content.vault_shares($1)",
        [vault],
      );
      expect(grants.map((g) => g.principal_id)).toEqual([s.groups.corpTeam]);
      await tx.as(s.ben, s.acme);
      expect(await count(tx, "content.vault where id = $1", [vault])).toBe(0);
    });
  });

  it("keeps a file in a matter vault on that matter", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ana, s.acme);
      const { id: vault } = await tx.one<{ id: string }>(
        "insert into content.vault (workspace_id, owner_id, matter_id, name) values ($1, $2, $3, 'M2') returning id",
        [s.acme, s.ana, s.matters.m2],
      );
      const insert = (matter: string | null) =>
        tx.error(
          `insert into content.document (workspace_id, owner_id, matter_id, name, mime, size, vault_id)
           values ($1, $2, $3, 'a.txt', 'text/plain', 1, $4)`,
          [s.acme, s.ana, matter, vault],
        );
      expect(await insert(null)).toMatch(/row-level security/);
      expect(await insert(s.matters.m2)).toBeUndefined();
    });
  });
});

describe("guests", () => {
  it("can't be given a vault directly, nor reach one through a group", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ana, s.acme);
      expect(
        await tx.error("select content.set_vault_shares($1, $2, false)", [
          s.vaults.acme.vaultId,
          JSON.stringify([{ principal_type: "user", principal_id: s.gia, level: "view" }]),
        ]),
      ).toMatch(/through a Space/);
      await share(tx, s, [
        { principal_type: "group", principal_id: s.groups.partyP, level: "view" },
      ]);
      await tx.as(s.gia, s.acme);
      expect(await vaultFiles(tx, s)).toBe(0);
      expect(await count(tx, "content.vault")).toBe(0);
    });
  });
});

describe("the recycle bin", () => {
  it("hides a deleted folder's files and brings them back on restore", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const { vaultId, folderId } = s.vaults.acme;
      await tx.as(s.ana, s.acme);
      expect(
        (
          await tx.one<{ n: number }>("select content.trash_items($1, '{}', $2) n", [
            vaultId,
            [folderId],
          ])
        ).n,
      ).toBe(2);
      expect(await vaultFiles(tx, s)).toBe(0);
      const bin = await tx.rows<{ kind: string; id: string }>(
        "select kind, id from content.vault_bin($1)",
        [vaultId],
      );
      expect(bin).toEqual([{ kind: "folder", id: folderId }]);
      await tx.rows("select content.restore_items($1, '{}', $2)", [vaultId, [folderId]]);
      expect(await vaultFiles(tx, s)).toBe(1);
      expect(await tx.rows("select * from content.vault_bin($1)", [vaultId])).toEqual([]);
    });
  });

  it("restores a file to the top when its folder stays deleted", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const { vaultId, folderId, documentId } = s.vaults.acme;
      await tx.as(s.ana, s.acme);
      await tx.rows("select content.trash_items($1, $2, '{}')", [vaultId, [documentId]]);
      await tx.rows("select content.trash_items($1, '{}', $2)", [vaultId, [folderId]]);
      await tx.rows("select content.restore_items($1, $2, '{}')", [vaultId, [documentId]]);
      const row = await tx.one<{ folder_id: string | null }>(
        "select folder_id from content.document where id = $1",
        [documentId],
      );
      expect(row.folder_id).toBeNull();
    });
  });

  it("hides a deleted vault's files until its owner restores it", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ana, s.acme);
      await tx.rows("select content.trash_vault($1)", [s.vaults.acme.vaultId]);
      expect(await vaultFiles(tx, s)).toBe(0);
      expect(await count(tx, "content.vault where deleted_at is not null")).toBe(1);
      await tx.as(s.ben, s.acme);
      expect(
        (
          await tx.one<{ ok: boolean }>("select content.restore_vault($1) ok", [
            s.vaults.acme.vaultId,
          ])
        ).ok,
      ).toBe(false);
      await tx.as(s.ana, s.acme);
      await tx.rows("select content.restore_vault($1)", [s.vaults.acme.vaultId]);
      expect(await vaultFiles(tx, s)).toBe(1);
    });
  });

  it("lets only an admin purge a deleted vault, and returns the files nothing else uses", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await addFile(tx, s, null, "Gone soon.");
      await tx.as(s.ana, s.acme);
      expect(await tx.error("select content.purge_vault($1)", [s.vaults.acme.vaultId])).toMatch(
        /deleted vault/,
      );
      await tx.rows("select content.trash_vault($1)", [s.vaults.acme.vaultId]);
      const gone = await tx.rows<{ sha256: Buffer }>("select * from content.purge_vault($1)", [
        s.vaults.acme.vaultId,
      ]);
      expect(gone.map((row) => row.sha256.toString("hex"))).toEqual(["cd".repeat(32)]);
      await tx.asOwner();
      expect(await count(tx, "content.vault where id = $1", [s.vaults.acme.vaultId])).toBe(0);
    });
  });
});

describe("limits, transfer and retention", () => {
  it("refuses files past the vault's limit, which a workspace may lower", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const room = async (files: number, bytes: number) =>
        (
          await tx.one<{ r: string | null }>("select content.claim_vault_room($1, $2, $3) r", [
            s.vaults.acme.vaultId,
            files,
            bytes,
          ])
        ).r;
      await tx.as(s.ana, s.acme);
      expect(await room(99_999, 1)).toBeNull();
      expect(await room(100_000, 1)).toBe("VAULT_FILE_LIMIT");
      expect(await room(1, 107_374_182_400)).toBe("VAULT_SIZE_LIMIT");
      await tx.asOwner();
      await tx.rows(
        `update core.workspace set settings = '{"vault_limits": {"files": 1}}' where id = $1`,
        [s.acme],
      );
      await tx.as(s.ana, s.acme);
      expect(await room(1, 1)).toBe("VAULT_FILE_LIMIT");
    });
  });

  it("transfers ownership and leaves the old owner with full access", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ben, s.acme);
      expect(
        await tx.error("select content.transfer_vault($1, $2)", [s.vaults.acme.vaultId, s.ben]),
      ).toMatch(/admin/);
      await tx.as(s.ana, s.acme);
      await tx.rows("select content.transfer_vault($1, $2)", [s.vaults.acme.vaultId, s.ben]);
      expect(
        (await tx.one<{ l: string }>("select content.vault_level($1) l", [s.vaults.acme.vaultId]))
          .l,
      ).toBe("full");
      await tx.as(s.ben, s.acme);
      expect(
        (await tx.one<{ l: string }>("select content.vault_level($1) l", [s.vaults.acme.vaultId]))
          .l,
      ).toBe("owner");
    });
  });

  it("deletes files past a vault's retention for good, with no way back", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const { vaultId, documentId } = s.vaults.acme;
      await tx.asOwner();
      await tx.rows("update content.vault set retention_hours = 3 where id = $1", [vaultId]);
      await tx.rows(
        "update content.document set created_at = now() - interval '4 hours' where id = $1",
        [documentId],
      );
      await tx.asWorker();
      expect((await tx.one<{ n: number }>("select content.sweep_vault_retention() n")).n).toBe(1);
      await tx.asOwner();
      expect(
        await tx.one("select deleted_reason from content.document where id = $1", [documentId]),
      ).toEqual({ deleted_reason: "retention" });
      const actions = await tx.rows<{ action: string; reason: string | null }>(
        `select action, details ->> 'deleted_reason' reason from admin.audit_event
          where workspace_id = $1 order by seq desc limit 2`,
        [s.acme],
      );
      expect(actions).toEqual([
        { action: "retention.sweep", reason: null },
        { action: "document.deleted", reason: "retention" },
      ]);
      await tx.as(s.ana, s.acme);
      await tx.rows("select content.restore_items($1, $2, '{}')", [vaultId, [documentId]]);
      await tx.asOwner();
      expect(
        await tx.one("select deleted_reason from content.document where id = $1", [documentId]),
      ).toEqual({ deleted_reason: "retention" });
      // Retention is final: the purge removes it at once, not after 30 days.
      await tx.asWorker();
      await tx.rows("select * from content.purge_expired_bin(30)");
      await tx.asOwner();
      expect(await count(tx, "content.document where id = $1", [documentId])).toBe(0);
    });
  });
});
