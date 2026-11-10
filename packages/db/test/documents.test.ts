import { describe, expect, it } from "vitest";
import { type Tx, withTx } from "./db.js";
import { type Seed, seed } from "./fixtures.js";

const SHA = `\\x${"ab".repeat(32)}`;

async function addDocument(tx: Tx, ws: string, owner: string, matter: string | null, text: string) {
  await tx.asOwner();
  const { id: documentId } = await tx.one<{ id: string }>(
    `insert into content.document (workspace_id, owner_id, matter_id, name, mime, size)
     values ($1, $2, $3, 'a.txt', 'text/plain', 10) returning id`,
    [ws, owner, matter],
  );
  const { id: versionId } = await tx.one<{ id: string }>(
    `insert into content.document_version (workspace_id, document_id, sha256, page_count, created_by)
     values ($1, $2, $3, 1, $4) returning id`,
    [ws, documentId, SHA, owner],
  );
  await tx.rows(
    `insert into content.page (workspace_id, version_id, page_no, width, height, text, layout)
     values ($1, $2, 1, 612, 792, $3, '{"blocks":[]}')`,
    [ws, versionId, text],
  );
  await tx.rows(
    `insert into content.chunk (workspace_id, version_id, page_no, ordinal, char_from, char_to, text)
     values ($1, $2, 1, 0, 0, $3, $4)`,
    [ws, versionId, text.length, text],
  );
  return { documentId, versionId };
}

async function visibleTo(tx: Tx, s: Seed, user: string, ws = s.acme) {
  await tx.as(user, ws);
  const count = async (table: string) =>
    Number((await tx.one<{ n: string }>(`select count(*) n from content.${table}`)).n);
  return {
    documents: await count("document"),
    versions: await count("document_version"),
    pages: await count("page"),
    chunks: await count("chunk"),
  };
}

const none = { documents: 0, versions: 0, pages: 0, chunks: 0 };
// The fixture gives each workspace one document of its owner's.
const fixture = { documents: 1, versions: 1, pages: 1, chunks: 1 };
const plusOne = { documents: 2, versions: 2, pages: 2, chunks: 2 };

describe("who can see a document", () => {
  it("shows the owner the document and everything under it", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      expect(await visibleTo(tx, s, s.ana)).toEqual(fixture);
    });
  });

  it("hides it from another member, even an admin", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      expect(await visibleTo(tx, s, s.ben)).toEqual(none);
      await addDocument(tx, s.acme, s.ben, null, "Ben's private note");
      expect(await visibleTo(tx, s, s.ana)).toEqual(fixture);
    });
  });

  it("hides every page and chunk once a wall shuts the owner out", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await addDocument(tx, s.acme, s.ben, s.matters.m1, "Walled text");
      expect(await visibleTo(tx, s, s.ben)).toEqual(none);
      await addDocument(tx, s.acme, s.ana, s.matters.m1, "Allowed text");
      expect(await visibleTo(tx, s, s.ana)).toEqual(plusOne);
    });
  });

  it("shows a suspended owner nothing", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await addDocument(tx, s.acme, s.sue, null, "Sue's text");
      expect(await visibleTo(tx, s, s.sue)).toEqual(none);
    });
  });
});

describe("who can add a document", () => {
  const insert = (tx: Tx, ws: string, owner: string, matter: string | null = null) =>
    tx.error(
      `insert into content.document (workspace_id, owner_id, matter_id, name, mime, size)
       values ($1, $2, $3, 'b.txt', 'text/plain', 1)`,
      [ws, owner, matter],
    );

  it("lets a member with threads.use add their own", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ben, s.acme);
      expect(await insert(tx, s.acme, s.ben)).toBeUndefined();
    });
  });

  it("refuses someone without the permission", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.gia, s.acme);
      expect(await insert(tx, s.acme, s.gia)).toMatch(/row-level security/);
    });
  });

  it("refuses a document in someone else's name or behind a wall", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ben, s.acme);
      expect(await insert(tx, s.acme, s.ana)).toMatch(/row-level security/);
      expect(await insert(tx, s.acme, s.ben, s.matters.m1)).toMatch(/row-level security/);
    });
  });

  it("refuses text added to another person's document", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ben, s.acme);
      expect(
        await tx.error(
          `insert into content.document_version (workspace_id, document_id, version_no, sha256, page_count, created_by)
           values ($1, $2, 2, $3, 1, $4)`,
          [s.acme, s.documents.acme.documentId, SHA, s.ben],
        ),
      ).toMatch(/row-level security/);
      expect(
        await tx.error(
          `insert into content.page (workspace_id, version_id, page_no, width, height, text, layout)
           values ($1, $2, 2, 1, 1, 'planted', '{}')`,
          [s.acme, s.documents.acme.versionId],
        ),
      ).toMatch(/row-level security/);
    });
  });

  it("cannot link a row across workspaces", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.asOwner();
      expect(
        await tx.error(
          `insert into content.page (workspace_id, version_id, page_no, width, height, text, layout)
           values ($1, $2, 2, 1, 1, 'x', '{}')`,
          [s.acme, s.documents.beta.versionId],
        ),
      ).toMatch(/foreign key/);
    });
  });
});

describe("what the app role can do", () => {
  it("can't rewrite or delete text a citation may depend on", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ana, s.acme);
      expect(await tx.error("update content.page set text = 'changed'")).toMatch(/permission/);
      expect(await tx.error("delete from content.chunk")).toMatch(/permission/);
    });
  });

  it("can store an original but not read one back", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.asOwner();
      const { id: versionId } = await tx.one<{ id: string }>(
        `insert into content.document_version (workspace_id, document_id, version_no, sha256, page_count, created_by)
         values ($1, $2, 2, $3, 1, $4) returning id`,
        [s.acme, s.documents.acme.documentId, SHA, s.ana],
      );
      await tx.as(s.ana, s.acme);
      expect(
        await tx.error(
          "insert into content.document_blob (workspace_id, version_id, bytes) values ($1, $2, '\\x00')",
          [s.acme, versionId],
        ),
      ).toBeUndefined();
      expect(await tx.error("select bytes from content.document_blob")).toMatch(/permission/);
    });
  });
});

describe("the text index", () => {
  it("finds a chunk by another form of a word", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ana, s.acme);
      const found = await tx.rows(
        "select id from content.chunk where tsv @@ websearch_to_tsquery('english', 'liabilities')",
      );
      expect(found).toHaveLength(1);
    });
  });
});
