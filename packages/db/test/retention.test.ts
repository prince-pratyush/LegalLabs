import { describe, expect, it } from "vitest";
import { withTx } from "./db.js";
import { seed } from "./fixtures.js";

describe("retention schema", () => {
  it("is readable by retention admins only, never across workspaces, and never writable directly", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      await tx.asOwner();
      await tx.rows(
        `insert into retention.policy (workspace_id, scope, scope_id, hours) values ($1, 'workspace', $1, 24)`,
        [s.acme],
      );
      await tx.as(s.ana, s.acme);
      expect(await tx.rows("select 1 from retention.policy")).toHaveLength(1);
      expect(await tx.rows("select 1 from retention.deletion_job")).toHaveLength(0);
      await tx.as(s.ben, s.acme);
      expect(await tx.rows("select 1 from retention.policy")).toHaveLength(0);
      expect(await tx.error("select retention.estimate('workspace', $1, 24)", [s.acme])).toMatch(
        /FORBIDDEN/,
      );
      await tx.as(s.ana, s.acme);
      expect(
        await tx.error(
          "insert into retention.policy (workspace_id, scope, scope_id, hours) values ($1, 'vault', $2, 24)",
          [s.acme, s.vaults.acme.vaultId],
        ),
      ).toMatch(/permission denied/);
      expect(
        await tx.error("select retention.set_policy('workspace', $1, 2, null)", [s.acme]),
      ).toMatch(/RETENTION_MIN/);
    });
  });

  it("hides a binned thread and everything under it from its owner", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const { threadId } = s.threads.acme;
      await tx.as(s.ana, s.acme);
      expect(
        await tx.rows("select 1 from work.message where thread_id = $1", [threadId]),
      ).not.toHaveLength(0);
      await tx.asOwner();
      await tx.rows("update work.thread set deleted_at = now() where id = $1", [threadId]);
      await tx.as(s.ana, s.acme);
      expect(await tx.rows("select 1 from work.thread where id = $1", [threadId])).toHaveLength(0);
      expect(
        await tx.rows("select 1 from work.message where thread_id = $1", [threadId]),
      ).toHaveLength(0);
    });
  });

  it("stamps restored_at when a file leaves the bin", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const id = s.vaults.acme.documentId;
      await tx.asOwner();
      await tx.rows(
        "update content.document set deleted_at = now(), deleted_reason = 'user' where id = $1",
        [id],
      );
      await tx.rows(
        "update content.document set deleted_at = null, deleted_reason = null where id = $1",
        [id],
      );
      expect(
        (await tx.one("select restored_at from content.document where id = $1", [id])).restored_at,
      ).not.toBeNull();
    });
  });
});
