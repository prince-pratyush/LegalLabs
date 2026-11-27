import { describe, expect, it } from "vitest";
import { type Tx, withTx } from "./db.js";
import { seed } from "./fixtures.js";

type Seed = Awaited<ReturnType<typeof seed>>;

/** A vault shared with the Space, holding one document with one page. */
async function shared(tx: Tx, s: Seed) {
  const spaceId = s.spaces.acme.spaceId;
  const { vaultId } = s.vaults.acme;
  // The seed's own facts are checked now, as their owner, not later as someone who can't see them.
  await tx.rows("set constraints all immediate");
  await tx.rows("set constraints all deferred");
  await tx.rows(
    `insert into work.space_resource (workspace_id, space_id, resource_type, resource_id,
       access, granted_by)
     values ($1, $2, 'vault', $3, 'view', $4) on conflict do nothing`,
    [s.acme, spaceId, vaultId, s.ana],
  );
  const { id: documentId } = await tx.one<{ id: string }>(
    `insert into content.document (workspace_id, owner_id, name, mime, size, vault_id)
     values ($1, $2, 'letter.txt', 'text/plain', 10, $3) returning id`,
    [s.acme, s.ana, vaultId],
  );
  const { id: versionId } = await tx.one<{ id: string }>(
    `insert into content.document_version (workspace_id, document_id, sha256, page_count, created_by)
     values ($1, $2, sha256('letter'), 1, $3) returning id`,
    [s.acme, documentId, s.ana],
  );
  return { spaceId, vaultId, documentId, versionId };
}

type Shared = Awaited<ReturnType<typeof shared>>;

const insertFact = `insert into apps.fact (workspace_id, space_id, created_by, source,
    source_documents, text, date_precision)
  values ($1, $2, $3, 'extracted', array[$4::uuid], 'Zed signed the letter.', 'unknown')
  returning id`;

/** As the person: a whole fact, with its version, quote and an extracted name. */
async function fact(tx: Tx, s: Seed, d: Shared) {
  const { id } = await tx.one<{ id: string }>(insertFact, [s.acme, d.spaceId, s.ana, d.documentId]);
  await tx.rows(
    `insert into apps.fact_version (workspace_id, fact_id, no, text, date_precision, edited_by)
     values ($1, $2, 1, 'Zed signed the letter.', 'unknown', $3)`,
    [s.acme, id, s.ana],
  );
  await tx.rows(
    `insert into apps.fact_citation (workspace_id, fact_id, document_id, document_version_id,
       page_no, char_from, char_to, quote)
     values ($1, $2, $3, $4, 1, 0, 10, 'Zed signed')`,
    [s.acme, id, d.documentId, d.versionId],
  );
  const { id: entityId } = await tx.one<{ id: string }>("select core.uuid7() id");
  await tx.rows(
    `insert into apps.entity (id, workspace_id, space_id, kind, canonical_name, origin, created_by)
     values ($1, $2, $3, 'person', 'Zed', 'extracted', $4)`,
    [entityId, s.acme, d.spaceId, s.ana],
  );
  await tx.rows(
    `insert into apps.fact_entity (workspace_id, space_id, fact_id, entity_id, via)
     values ($1, $2, $3, $4, 'extracted')`,
    [s.acme, d.spaceId, id, entityId],
  );
  await tx.rows("set constraints all immediate");
  await tx.rows("set constraints all deferred");
  return { factId: id, entityId };
}

const count = async (tx: Tx, sql: string, params: unknown[] = []) =>
  Number((await tx.one<{ n: string }>(`select count(*) n from ${sql}`, params)).n);

describe("fact tables in the database", () => {
  it("keeps what a fact cites, and every version of it, out of reach of an update", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const d = await shared(tx, s);
      await tx.as(s.ana, s.acme);
      const { factId } = await fact(tx, s, d);
      const refused = async (sql: string) =>
        expect(await tx.error(sql, [factId])).toMatch(/permission denied|new version/);
      await refused("update apps.fact set source_documents = '{}' where id = $1");
      await refused("update apps.fact set created_by = created_by where id = $1");
      await refused("update apps.fact set text = 'Rewritten.' where id = $1");
      await refused("delete from apps.fact where id = $1");
      await refused("update apps.fact_citation set quote = 'other' where fact_id = $1");
      await refused("update apps.fact_version set text = 'other' where fact_id = $1");
      await refused("delete from apps.fact_audit where fact_id = $1");
      // A new version number without the version itself fails as the transaction ends.
      await tx.rows("update apps.fact set text = 'Rewritten.', version_no = 2 where id = $1", [
        factId,
      ]);
      expect(await tx.error("set constraints all immediate")).toMatch(/keeps every version/);
    });
  });

  it("refuses a fact with no quote from the document it names", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const d = await shared(tx, s);
      await tx.as(s.ana, s.acme);
      const { id } = await tx.one<{ id: string }>(insertFact, [
        s.acme,
        d.spaceId,
        s.ana,
        d.documentId,
      ]);
      expect(id).toBeTruthy();
      expect(await tx.error("set constraints all immediate")).toMatch(/needs a quote/);
    });
  });

  it("refuses a fact from a document outside the Space's vaults", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const d = await shared(tx, s);
      await tx.as(s.ana, s.acme);
      expect(
        await tx.error(insertFact, [s.acme, d.spaceId, s.ana, s.documents.acme.documentId]),
      ).toMatch(/row-level security/);
    });
  });

  it("shows nothing to a guest of the Space, not even a typed name", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const room = s.guestRooms.acme;
      await tx.rows(
        `insert into apps.entity (workspace_id, space_id, kind, canonical_name, origin, created_by)
         values ($1, $2, 'org', 'Acme', 'manual', $3)`,
        [s.acme, room.spaceId, s.ana],
      );
      await tx.as(room.guestId, s.acme);
      for (const table of ["fact", "fact_citation", "entity", "issue", "fact_audit"]) {
        expect({ table, n: await count(tx, `apps.${table}`) }).toEqual({ table, n: 0 });
      }
    });
  });

  it("won't open a read name to the Space by changing only its case or spacing", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const d = await shared(tx, s);
      await tx.as(s.ana, s.acme);
      const { entityId } = await fact(tx, s, d);
      expect(
        await tx.error(
          "update apps.entity set canonical_name = ' zed ', origin = 'manual' where id = $1",
          [entityId],
        ),
      ).toMatch(/same name/);
    });
  });

  it("keeps a read name while any fact links it, and drops it with the last link", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const d = await shared(tx, s);
      await tx.as(s.ana, s.acme);
      const first = await fact(tx, s, d);
      const second = await fact(tx, s, d);
      await tx.rows(
        `insert into apps.fact_entity (workspace_id, space_id, fact_id, entity_id, via)
         values ($1, $2, $3, $4, 'manual')`,
        [s.acme, d.spaceId, second.factId, first.entityId],
      );
      const unlink = (factId: string) =>
        tx.rows("delete from apps.fact_entity where fact_id = $1 and entity_id = $2", [
          factId,
          first.entityId,
        ]);
      const left = async (table: string, column: string) => {
        await tx.asOwner();
        const n = await count(tx, `apps.${table} where ${column} = $1`, [first.entityId]);
        await tx.as(s.ana, s.acme);
        return n;
      };
      await unlink(first.factId);
      // Still linked by hand elsewhere: kept, but no longer open through that link.
      expect(await count(tx, "apps.entity where id = $1", [first.entityId])).toBe(0);
      expect(await left("entity", "id")).toBe(1);
      expect(await left("fact_entity", "entity_id")).toBe(1);
      await unlink(second.factId);
      expect(await left("entity", "id")).toBe(0);
    });
  });

  it("takes facts, their trail and extracted names away with a purged document", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const d = await shared(tx, s);
      await tx.as(s.ana, s.acme);
      const { factId, entityId } = await fact(tx, s, d);
      await tx.rows(
        `insert into apps.fact_audit (workspace_id, space_id, fact_id, actor_id, action, details)
         values ($1, $2, $3, $4, 'created', '{"text":"Zed signed the letter."}')`,
        [s.acme, d.spaceId, factId, s.ana],
      );
      await tx.asOwner();
      await tx.rows("delete from content.document where id = $1", [d.documentId]);
      for (const [table, column, id] of [
        ["fact", "id", factId],
        ["fact_version", "fact_id", factId],
        ["fact_audit", "fact_id", factId],
        ["fact_entity", "fact_id", factId],
        ["entity", "id", entityId],
      ]) {
        expect({
          table,
          n: await count(tx, `apps.${table} where ${column} = $1`, [id]),
        }).toEqual({
          table,
          n: 0,
        });
      }
    });
  });
});
