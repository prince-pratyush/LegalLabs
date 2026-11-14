import { describe, expect, it } from "vitest";
import { type Tx, withTx } from "./db.js";
import { seed } from "./fixtures.js";

const version = (tx: Tx, ws: string, draft: string, no: number, user: string) =>
  tx.error(
    `insert into work.draft_version (workspace_id, draft_id, no, body, author, created_by)
     values ($1, $2, $3, 'v', 'user', $4)`,
    [ws, draft, no, user],
  );

describe("drafts", () => {
  it("are read with their thread and written only by its owner", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const { draftId } = s.threads.acme;
      await tx.as(s.ana, s.acme);
      expect(await tx.rows("select no from work.draft_version")).toEqual([{ no: 1 }]);
      expect(await version(tx, s.acme, draftId, 2, s.ana)).toBeUndefined();
      await tx.as(s.ben, s.acme);
      expect(await tx.rows("select id from work.draft")).toEqual([]);
      expect(await version(tx, s.acme, draftId, 3, s.ben)).toMatch(/row-level security/);
    });
  });

  it("never change once written", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ana, s.acme);
      expect(await tx.error("update work.draft_version set body = 'x'")).toMatch(
        /permission denied/,
      );
      expect(await tx.error("delete from work.draft_version")).toMatch(/permission denied/);
    });
  });

  it("stop at twenty per thread", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const { threadId } = s.threads.acme;
      await tx.as(s.ana, s.acme);
      const add = () =>
        tx.error(
          `insert into work.draft (workspace_id, thread_id, owner_id, kind, title)
           values ($1, $2, $3, 'notepad', 'Note')`,
          [s.acme, threadId, s.ana],
        );
      for (let i = 1; i < 20; i++) expect(await add()).toBeUndefined();
      expect(await add()).toMatch(/LIMIT_DRAFTS/);
    });
  });
});
