import { describe, expect, it } from "vitest";
import { type Tx, withTx } from "./db.js";
import { seed } from "./fixtures.js";

const add = (tx: Tx, ws: string, thread: string, message: string, owner: string, docs: string[]) =>
  tx.error(
    `insert into work.thread_output
       (workspace_id, thread_id, message_id, owner_id, name, format, size, source_documents, bytes)
     values ($1, $2, $3, $4, 'a.xlsx', 'xlsx', 1, $5, '\\x00')`,
    [ws, thread, message, owner, docs],
  );

const count = async (tx: Tx) =>
  Number((await tx.one<{ n: string }>("select count(*) n from work.thread_output")).n);

describe("files a thread made, in the database", () => {
  it("are the owner's alone and never change", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const { threadId, messageId } = s.threads.acme;
      await tx.as(s.ana, s.acme);
      expect(await count(tx)).toBe(1);
      expect(await tx.error("update work.thread_output set name = 'x'")).toMatch(
        /permission denied/,
      );
      expect(await tx.error("delete from work.thread_output")).toMatch(/permission denied/);
      await tx.as(s.ben, s.acme);
      expect(await count(tx)).toBe(0);
      expect(await add(tx, s.acme, threadId, messageId, s.ben, [])).toMatch(/row-level security/);
    });
  });

  it("are hidden from an owner who can't open every file they were made from", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const { threadId, messageId } = s.threads.acme;
      await tx.as(s.ana, s.acme);
      // A document of another workspace stands for one this person can't open.
      expect(
        await add(tx, s.acme, threadId, messageId, s.ana, [s.documents.beta.documentId]),
      ).toBeUndefined();
      expect(await count(tx)).toBe(1);
    });
  });
});
