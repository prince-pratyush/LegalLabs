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

type Claimed = { version_id: string; attempt: number; created_by: string; lease: string };

async function claim(tx: Tx, s: Seed, maxAttempts = 3) {
  await tx.asWorker();
  return (
    await tx.rows<Claimed>("select * from content.claim_ingest_job(60, $1, $2)", [
      maxAttempts,
      s.acme,
    ])
  )[0];
}

async function addPage(tx: Tx, s: Seed, versionId: string) {
  await tx.as(s.ana, s.acme);
  await tx.rows(
    `insert into content.page (workspace_id, version_id, page_no, width, height, text, layout)
     values ($1, $2, 1, 0, 0, 'text', '{"blocks":[]}')`,
    [s.acme, versionId],
  );
}

const finish = async (
  tx: Tx,
  s: Seed,
  versionId: string,
  lease: string,
  status = "indexed",
  user = s.ana,
) => {
  await tx.as(user, s.acme);
  return (
    await tx.one<{ ok: boolean }>("select content.finish_ingest_job($1, $2, $3, $4) ok", [
      versionId,
      lease,
      status,
      status === "failed" ? "CORRUPT_FILE" : null,
    ])
  ).ok;
};

const expire = async (tx: Tx, versionId: string) => {
  await tx.asOwner();
  await tx.rows(
    "update content.ingest_job set leased_until = now() - interval '1 second' where version_id = $1",
    [versionId],
  );
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

  it("is claimed once, and only by the worker role", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const versionId = await queued(tx, s);
      for (const [user, ws] of [
        [s.ana, s.acme],
        [null, null],
      ] as const) {
        await tx.as(user, ws);
        expect(
          await tx.error("select * from content.claim_ingest_job(60, 3, $1)", [s.acme]),
        ).toMatch(/permission/);
      }
      expect(await claim(tx, s)).toMatchObject({
        version_id: versionId,
        attempt: 1,
        created_by: s.ana,
      });
      expect(await claim(tx, s)).toBeUndefined();
    });
  });

  it("counts the pages itself when a job finishes", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const versionId = await queued(tx, s);
      const job = await claim(tx, s);
      await tx.as(s.ana, s.acme);
      expect(
        await tx.error("select content.finish_ingest_job($1, $2, 'indexed')", [
          versionId,
          job?.lease,
        ]),
      ).toMatch(/needs its pages/);
      await addPage(tx, s, versionId);
      expect(await finish(tx, s, versionId, job?.lease ?? "")).toBe(true);
      expect(await statusOf(tx, versionId)).toMatchObject({ status: "indexed", reason: null });
      const { page_count } = await tx.one<{ page_count: number }>(
        "select page_count from content.document_version where id = $1",
        [versionId],
      );
      expect(page_count).toBe(1);
    });
  });

  it("can't be settled without the lease, even by its uploader", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const versionId = await queued(tx, s);
      await claim(tx, s);
      const guess = "00000000-0000-4000-8000-000000000000";
      expect(await finish(tx, s, versionId, guess, "failed")).toBe(false);
      expect(await finish(tx, s, versionId, guess, "failed", s.ben)).toBe(false);
    });
  });

  it("refuses a late worker once the job was claimed again", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const versionId = await queued(tx, s);
      const first = await claim(tx, s);
      await expire(tx, versionId);
      const second = await claim(tx, s);
      expect(second).toMatchObject({ attempt: 2 });
      expect(await finish(tx, s, versionId, first?.lease ?? "", "failed")).toBe(false);
      expect(await finish(tx, s, versionId, second?.lease ?? "", "failed")).toBe(true);
    });
  });

  it("keeps a renewed lease and loses an expired one", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const versionId = await queued(tx, s);
      const job = await claim(tx, s);
      const renew = async (lease: string) => {
        await tx.asWorker();
        return (
          await tx.one<{ ok: boolean }>("select content.renew_ingest_lease($1, $2, 60) ok", [
            versionId,
            lease,
          ])
        ).ok;
      };
      expect(await renew(job?.lease ?? "")).toBe(true);
      expect(await renew("00000000-0000-4000-8000-000000000000")).toBe(false);
    });
  });

  it("fails a file that keeps killing its worker", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const versionId = await queued(tx, s);
      await claim(tx, s, 2);
      await expire(tx, versionId);
      await claim(tx, s, 2);
      await expire(tx, versionId);
      expect(await claim(tx, s, 2)).toBeUndefined();
      expect(await statusOf(tx, versionId)).toMatchObject({
        status: "failed",
        reason: "INTERNAL",
        attempts: 2,
      });
    });
  });

  it("lets only the uploader retry a failed file, after a pause", async () => {
    await withTx(async (tx) => {
      const s = await seed(tx);
      const versionId = await queued(tx, s);
      const job = await claim(tx, s);
      await finish(tx, s, versionId, job?.lease ?? "", "failed");
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
      expect(await retry(s.ana, s.acme)).toBe(false);
      await tx.asOwner();
      await tx.rows(
        "update content.ingest_job set updated_at = now() - interval '2 minutes' where version_id = $1",
        [versionId],
      );
      expect(await retry(s.ben, s.acme)).toBe(false);
      expect(await retry(s.bob, s.beta)).toBe(false);
      expect(await retry(s.ana, s.acme)).toBe(true);
      expect(await statusOf(tx, versionId)).toMatchObject({ status: "queued", attempts: 0 });
      expect(await retry(s.ana, s.acme)).toBe(false);
    });
  });
});
