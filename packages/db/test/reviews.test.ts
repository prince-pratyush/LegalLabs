import { describe, expect, it } from "vitest";
import { type Tx, withTx } from "./db.js";
import { seed } from "./fixtures.js";

const allow = async (tx: Tx, user: string, permissions: string[]) => {
  await tx.asOwner();
  await tx.rows(`update core."user" set extra_permissions = $2 where id = $1`, [user, permissions]);
};

const count = async (tx: Tx, table: string) =>
  Number((await tx.one<{ n: string }>(`select count(*) n from ${table}`)).n);

describe("playbook reviews", () => {
  it("are seen only by those who can read both the document and the playbook", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ana, s.acme);
      expect(await count(tx, "work.playbook_review")).toBe(1);
      expect(await count(tx, "work.review_suggestion")).toBe(1);
      expect(await count(tx, "work.run_step")).toBe(1);

      // Ben edits the playbook through his team but can't read Ana's own document.
      await allow(tx, s.ben, ["playbooks.use"]);
      await tx.as(s.ben, s.acme);
      expect(
        await tx.one("select work.playbook_level($1) level", [s.playbooks.acme.playbookId]),
      ).toEqual({ level: "edit" });
      expect(await count(tx, "work.playbook_review")).toBe(0);
      expect(await count(tx, "work.review_suggestion")).toBe(0);
      // Nor can he start one on it.
      const { id: runId } = await tx.one<{ id: string }>("select core.uuid7() id");
      expect(
        await tx.error(
          `insert into work.run (id, workspace_id, owner_id, kind, status)
           values ($1, $2, $3, 'playbook_review', 'planned')`,
          [runId, s.acme, s.ben],
        ),
      ).toBeUndefined();
      expect(
        await tx.error(
          `insert into work.playbook_review (workspace_id, run_id, owner_id, playbook_id,
             playbook_version_id, playbook_name, rules, document_id, document_version_id,
             surface, customisation)
           values ($1, $2, $3, $4, $5, 'x', '[]', $6, $7, 'web', '{}')`,
          [
            s.acme,
            runId,
            s.ben,
            s.playbooks.acme.playbookId,
            s.playbooks.acme.versionId,
            s.documents.acme.documentId,
            s.documents.acme.versionId,
          ],
        ),
      ).toMatch(/row-level security/);
    });
  });

  it("are changed only by the one who ran them, and stay theirs", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const reviewId = s.reviews.acme.reviewId;
      await tx.as(s.ben, s.acme);
      await tx.rows("update work.playbook_review set status = 'failed' where id = $1", [reviewId]);
      await tx.as(s.ana, s.acme);
      expect(
        await tx.one("select status from work.playbook_review where id = $1", [reviewId]),
      ).toEqual({ status: "done" });
      expect(
        await tx.error("update work.review_suggestion set status = 'dismissed'"),
      ).toBeUndefined();
      expect(await tx.one("select status from work.review_suggestion")).toEqual({
        status: "dismissed",
      });
      // Another workspace sees nothing.
      await tx.as(s.bob, s.beta);
      expect(await tx.rows("select 1 from work.playbook_review where id = $1", [reviewId])).toEqual(
        [],
      );
    });
  });

  it("let a review run stand without a thread, but not a thread run", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.as(s.ana, s.acme);
      expect(
        await tx.error(
          `insert into work.run (workspace_id, owner_id, kind, status)
           values ($1, $2, 'thread', 'planned')`,
          [s.acme, s.ana],
        ),
      ).toMatch(/run_thread_check|row-level security/);
    });
  });
});
