import { describe, expect, it } from "vitest";
import { type Tx, withTx } from "./db.js";
import { type Seed, seed } from "./fixtures.js";

async function queued(tx: Tx, s: Seed) {
  await tx.asOwner();
  const { id } = await tx.one<{ id: string }>(
    `insert into content.document_version (workspace_id, document_id, version_no, sha256, created_by)
     values ($1, $2, 2, sha256('v2'), $3) returning id`,
    [s.acme, s.documents.acme.documentId, s.ana],
  );
  await tx.as(s.ana, s.acme);
  await tx.rows("insert into content.ingest_job (workspace_id, version_id) values ($1, $2)", [
    s.acme,
    id,
  ]);
  return id;
}

async function claim(tx: Tx, s: Seed, lease = 60) {
  await tx.as(null, null);
  return (
    await tx.rows<{ version_id: string; attempt: number; created_by: string }>(
      "select * from content.claim_ingest_job($1, $2)",
      [lease, s.acme],
    )
  )[0];
}

const finish = async (tx: Tx, s: Seed, versionId: string, attempt: number, status = "indexed") => {
  await tx.as(s.ana, s.acme);
  return (
    await tx.one<{ ok: boolean }>("select content.finish_ingest_job($1, $2, $3, $4, 3, 1) ok", [
      versionId,
      attempt,
      status,
      status === "failed" ? "CORRUPT_FILE" : null,
    ])
  ).ok;
};

const statusOf = async (tx: Tx, versionId: string) => {
  await tx.asOwner();
  return tx.one<{ status: string; reason: string | null; attempts: number }>(
    "select status, reason, attempts from content.ingest_job where version_id = $1",
    [versionId],
  );
};

describe("ingest jobs", () => {
  it("lets the uploader queue a job but not set its outcome", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const versionId = await queued(tx, s);
      expect(
        await tx.rows("select status from content.ingest_job where version_id = $1", [versionId]),
      ).toEqual([{ status: "queued" }]);
      expect(
        await tx.error("update content.ingest_job set status = 'indexed' where version_id = $1", [
          versionId,
        ]),
      ).toMatch(/permission/);
      expect(
        await tx.error(
          `insert into content.ingest_job (workspace_id, version_id, status)
           values ($1, $2, 'indexed')`,
          [s.acme, s.documents.acme.versionId],
        ),
      ).toMatch(/row-level security/);
    });
  });

  it("hides a job from other members and workspaces", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const versionId = await queued(tx, s);
      const mine = "select * from content.ingest_job where version_id = $1";
      await tx.as(s.ben, s.acme);
      expect(await tx.rows(mine, [versionId])).toEqual([]);
      await tx.as(s.bob, s.beta);
      expect(await tx.rows(mine, [versionId])).toEqual([]);
    });
  });

  it("is claimed once, by a worker with no identity", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const versionId = await queued(tx, s);
      await tx.as(s.ana, s.acme);
      expect(await tx.error("select * from content.claim_ingest_job(60, $1)", [s.acme])).toMatch(
        /without an identity/,
      );
      expect(await claim(tx, s)).toMatchObject({
        version_id: versionId,
        attempt: 1,
        created_by: s.ana,
      });
      expect(await claim(tx, s)).toBeUndefined();
    });
  });

  it("records the outcome and the page counts", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const versionId = await queued(tx, s);
      await claim(tx, s);
      expect(await finish(tx, s, versionId, 1)).toBe(true);
      expect(await statusOf(tx, versionId)).toMatchObject({ status: "indexed", reason: null });
      const { page_count } = await tx.one<{ page_count: number }>(
        "select page_count from content.document_version where id = $1",
        [versionId],
      );
      expect(page_count).toBe(3);
    });
  });

  it("refuses a late worker once the job was claimed again", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const versionId = await queued(tx, s);
      await claim(tx, s);
      await tx.asOwner();
      await tx.rows(
        "update content.ingest_job set leased_until = now() - interval '1 second' where version_id = $1",
        [versionId],
      );
      expect(await claim(tx, s)).toMatchObject({ attempt: 2 });
      expect(await finish(tx, s, versionId, 1)).toBe(false);
      expect(await finish(tx, s, versionId, 2)).toBe(true);
    });
  });

  it("lets only the uploader retry a failed file", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const versionId = await queued(tx, s);
      await claim(tx, s);
      await finish(tx, s, versionId, 1, "failed");
      expect(await statusOf(tx, versionId)).toMatchObject({
        status: "failed",
        reason: "CORRUPT_FILE",
      });
      const retry = async (user: string, ws: string) => {
        await tx.as(user, ws);
        return (
          await tx.one<{ ok: boolean }>("select content.retry_ingest_job($1) ok", [versionId])
        ).ok;
      };
      expect(await retry(s.ben, s.acme)).toBe(false);
      expect(await retry(s.bob, s.beta)).toBe(false);
      expect(await retry(s.ana, s.acme)).toBe(true);
      expect(await statusOf(tx, versionId)).toMatchObject({ status: "queued", attempts: 0 });
      expect(await retry(s.ana, s.acme)).toBe(false);
    });
  });
});
