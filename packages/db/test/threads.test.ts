import { describe, expect, it } from "vitest";
import { type Tx, withTx } from "./db.js";
import { type Seed, seed } from "./fixtures.js";

const SHA = `\\x${"cd".repeat(32)}`;

async function addDocument(tx: Tx, ws: string, owner: string, matter: string | null) {
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
  return versionId;
}

// Inserted as the owner, so read tests don't depend on the insert policies.
async function addThread(
  tx: Tx,
  ws: string,
  owner: string,
  matter: string | null,
  version: string,
) {
  await tx.asOwner();
  const { id: threadId } = await tx.one<{ id: string }>(
    `insert into work.thread (workspace_id, owner_id, matter_id, title)
     values ($1, $2, $3, 'Question') returning id`,
    [ws, owner, matter],
  );
  await tx.rows(
    "insert into work.thread_document (workspace_id, thread_id, version_id) values ($1, $2, $3)",
    [ws, threadId, version],
  );
  const { id: messageId } = await tx.one<{ id: string }>(
    `insert into work.message (workspace_id, thread_id, role, content)
     values ($1, $2, 'assistant', 'Answer') returning id`,
    [ws, threadId],
  );
  await tx.rows(
    `insert into work.citation (workspace_id, message_id, ordinal, anchor, version_id, page_no, quote, status)
     values ($1, $2, 0, 6, $3, 1, 'quote', 'unresolved')`,
    [ws, messageId, version],
  );
  return { threadId, messageId };
}

async function visibleTo(tx: Tx, s: Seed, user: string, ws = s.acme) {
  await tx.as(user, ws);
  const count = async (table: string) =>
    Number((await tx.one<{ n: string }>(`select count(*) n from work.${table}`)).n);
  return {
    threads: await count("thread"),
    documents: await count("thread_document"),
    messages: await count("message"),
    citations: await count("citation"),
  };
}

const none = { threads: 0, documents: 0, messages: 0, citations: 0 };
const fixture = { threads: 1, documents: 1, messages: 1, citations: 1 };
const plusOne = { threads: 2, documents: 2, messages: 2, citations: 2 };

const anasThread = (tx: Tx, s: Seed) =>
  tx.one<{ thread_id: string; message_id: string }>(
    `select t.id thread_id, m.id message_id
       from work.thread t join work.message m on m.thread_id = t.id
      where t.workspace_id = $1`,
    [s.acme],
  );

describe("who can see a thread", () => {
  it("shows the owner the thread and everything in it", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      expect(await visibleTo(tx, s, s.ana)).toEqual(fixture);
    });
  });

  it("hides it from another member, even an admin", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      expect(await visibleTo(tx, s, s.ben)).toEqual(none);
      const version = await addDocument(tx, s.acme, s.ben, null);
      await addThread(tx, s.acme, s.ben, null, version);
      expect(await visibleTo(tx, s, s.ana)).toEqual(fixture);
    });
  });

  it("hides everything once a wall shuts the owner out", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const walled = await addDocument(tx, s.acme, s.ben, s.matters.m1);
      await addThread(tx, s.acme, s.ben, s.matters.m1, walled);
      expect(await visibleTo(tx, s, s.ben)).toEqual(none);
      const allowed = await addDocument(tx, s.acme, s.ana, s.matters.m1);
      await addThread(tx, s.acme, s.ana, s.matters.m1, allowed);
      expect(await visibleTo(tx, s, s.ana)).toEqual(plusOne);
    });
  });

  it("shows a suspended owner nothing", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const version = await addDocument(tx, s.acme, s.sue, null);
      await addThread(tx, s.acme, s.sue, null, version);
      expect(await visibleTo(tx, s, s.sue)).toEqual(none);
    });
  });
});

describe("who can start a thread", () => {
  const insert = (tx: Tx, ws: string, owner: string, matter: string | null = null) =>
    tx.error(
      "insert into work.thread (workspace_id, owner_id, matter_id, title) values ($1, $2, $3, 'Q')",
      [ws, owner, matter],
    );

  it("lets a member with threads.use start their own", async () => {
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

  it("refuses a thread in someone else's name or behind a wall", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ben, s.acme);
      expect(await insert(tx, s.acme, s.ana)).toMatch(/row-level security/);
      expect(await insert(tx, s.acme, s.ben, s.matters.m1)).toMatch(/row-level security/);
    });
  });
});

describe("what a thread can hold", () => {
  const attach = (tx: Tx, ws: string, thread: string, version: string) =>
    tx.error(
      "insert into work.thread_document (workspace_id, thread_id, version_id) values ($1, $2, $3)",
      [ws, thread, version],
    );

  it("takes a document from the same matter", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const first = await addDocument(tx, s.acme, s.ana, s.matters.m2);
      const second = await addDocument(tx, s.acme, s.ana, s.matters.m2);
      const { threadId } = await addThread(tx, s.acme, s.ana, s.matters.m2, first);
      await tx.as(s.ana, s.acme);
      expect(await attach(tx, s.acme, threadId, second)).toBeUndefined();
    });
  });

  it("refuses a document from another matter, so walls can't be mixed", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const inM2 = await addDocument(tx, s.acme, s.ana, s.matters.m2);
      const { threadId } = await addThread(tx, s.acme, s.ana, s.matters.m2, inM2);
      await tx.as(s.ana, s.acme);
      expect(await attach(tx, s.acme, threadId, s.documents.acme.versionId)).toMatch(
        /row-level security/,
      );
    });
  });

  it("refuses a document the owner can't see", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const bens = await addDocument(tx, s.acme, s.ben, null);
      const { thread_id } = await anasThread(tx, s);
      await tx.as(s.ana, s.acme);
      expect(await attach(tx, s.acme, thread_id, bens)).toMatch(/row-level security/);
    });
  });

  it("refuses messages in someone else's thread", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const { thread_id } = await anasThread(tx, s);
      await tx.as(s.ben, s.acme);
      expect(
        await tx.error(
          `insert into work.message (workspace_id, thread_id, role, content)
           values ($1, $2, 'user', 'planted')`,
          [s.acme, thread_id],
        ),
      ).toMatch(/row-level security/);
    });
  });

  it("refuses a citation to a document the thread doesn't hold", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const other = await addDocument(tx, s.acme, s.ana, null);
      const { message_id } = await anasThread(tx, s);
      await tx.as(s.ana, s.acme);
      const cite = (ordinal: number, version: string | null) =>
        tx.error(
          `insert into work.citation (workspace_id, message_id, ordinal, anchor, version_id, status)
           values ($1, $2, $3, 0, $4, 'unresolved')`,
          [s.acme, message_id, ordinal, version],
        );
      expect(await cite(1, other)).toMatch(/row-level security/);
      expect(await cite(2, null)).toBeUndefined();
    });
  });

  it("only marks a citation ok with a place on a page", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const { message_id } = await anasThread(tx, s);
      await tx.asOwner();
      expect(
        await tx.error(
          `insert into work.citation (workspace_id, message_id, ordinal, anchor, status)
           values ($1, $2, 1, 0, 'ok')`,
          [s.acme, message_id],
        ),
      ).toMatch(/check constraint/);
    });
  });

  it("cannot link a row across workspaces", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const { thread_id } = await anasThread(tx, s);
      await tx.asOwner();
      expect(await attach(tx, s.acme, thread_id, s.documents.beta.versionId)).toMatch(
        /foreign key/,
      );
    });
  });
});

describe("what the app role can change", () => {
  it("can't rewrite or delete a stored answer or its citations", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ana, s.acme);
      expect(await tx.error("update work.message set content = 'changed'")).toMatch(/permission/);
      expect(await tx.error("update work.citation set status = 'ok'")).toMatch(/permission/);
      expect(await tx.error("delete from work.thread")).toMatch(/permission/);
    });
  });
});
