import type { IngestResult } from "@legallabs/ingest";
import { createMemoryStore } from "@legallabs/storage";
import { afterAll, describe, expect, it } from "vitest";
import type { Principal } from "../auth/auth.js";
import { auditTrail, type Seeded, seedMember, testDocuments, testPool } from "../test-db.js";
import type { IngestWorkerOptions } from "./worker.js";

const pool = testPool();
afterAll(() => pool.end());

const client = { ip: "203.0.113.9", userAgent: "vitest" };
const CLAUSE = "The supplier accepts liability for direct loss.";
const asPrincipal = (m: Seeded): Principal => ({
  sessionId: "00000000-0000-7000-8000-000000000000",
  userId: m.userId,
  workspaceId: m.workspaceId,
});

async function queue(m: Seeded, options: Partial<IngestWorkerOptions> = {}) {
  const documents = testDocuments(pool, options);
  const result = await documents.raw.upload(
    asPrincipal(m),
    { name: "a.txt", bytes: new TextEncoder().encode(CLAUSE), matterId: null },
    client,
  );
  if (!result.ok) throw new Error(result.reason);
  return { documents, document: result.document };
}

const job = async (versionId: string) =>
  (
    await pool.query<{ status: string; reason: string | null; attempts: number }>(
      "select status, reason, attempts from content.ingest_job where version_id = $1",
      [versionId],
    )
  ).rows[0];

const makeDue = (versionId: string) =>
  pool.query("update content.ingest_job set run_after = now() where version_id = $1", [versionId]);

describe("ingest worker", () => {
  it("indexes a queued file once, however often it runs", async () => {
    const m = await seedMember(pool);
    const { documents, document } = await queue(m);
    expect(await documents.worker.drain(m.workspaceId)).toBe(1);
    expect(await documents.worker.drain(m.workspaceId)).toBe(0);
    expect(await documents.get(asPrincipal(m), document.id)).toMatchObject({
      status: "indexed",
      pageCount: 1,
    });
    const { rows } = await pool.query<{ n: string }>(
      "select count(*) n from content.chunk where version_id = $1",
      [document.versionId],
    );
    expect(rows[0]?.n).toBe("1");
  });

  it("retries a crash later, then gives up with the reason", async () => {
    const m = await seedMember(pool);
    let calls = 0;
    const ingest = async (): Promise<IngestResult> => {
      calls++;
      return { ok: false, reason: "INTERNAL" };
    };
    const { documents, document } = await queue(m, { ingest, maxAttempts: 2 });
    await documents.worker.drain(m.workspaceId);
    expect(await job(document.versionId)).toEqual({ status: "queued", reason: null, attempts: 1 });
    await makeDue(document.versionId);
    await documents.worker.drain(m.workspaceId);
    expect(calls).toBe(2);
    expect(await job(document.versionId)).toEqual({
      status: "failed",
      reason: "INTERNAL",
      attempts: 2,
    });
  });

  it("fails at once on a file that can't be read, and records it", async () => {
    const m = await seedMember(pool);
    const { documents, document } = await queue(m, {
      ingest: async () => ({ ok: false, reason: "CORRUPT_FILE" }),
      maxAttempts: 3,
    });
    await documents.worker.drain(m.workspaceId);
    expect(await job(document.versionId)).toMatchObject({ status: "failed", attempts: 1 });
    const trail = await auditTrail(pool, m.workspaceId);
    expect(trail.at(-1)).toMatchObject({
      action: "document.ingest_failed",
      actor_type: "system",
      object_id: document.id,
      details: { version_id: document.versionId, failure_reason: "CORRUPT_FILE" },
    });
  });

  it("refuses an original that no longer matches its hash", async () => {
    const m = await seedMember(pool);
    const memory = createMemoryStore();
    const store = {
      ...memory,
      get: async () => new TextEncoder().encode("The supplier accepts no liability."),
    };
    const { documents, document } = await queue(m, { store });
    await documents.worker.drain(m.workspaceId);
    expect(await job(document.versionId)).toMatchObject({
      status: "failed",
      reason: "MISSING_ORIGINAL",
    });
  });

  it("retries when the store is down", async () => {
    const m = await seedMember(pool);
    let down = true;
    const memory = createMemoryStore();
    const store = {
      ...memory,
      get: async (key: string) => {
        if (down) throw new Error("object store GET failed with 503");
        return memory.get(key);
      },
    };
    const { documents, document } = await queue(m, { store, maxAttempts: 2 });
    await documents.worker.drain(m.workspaceId);
    expect(await job(document.versionId)).toMatchObject({ status: "queued", attempts: 1 });
    down = false;
    await makeDue(document.versionId);
    await documents.worker.drain(m.workspaceId);
    expect(await job(document.versionId)).toMatchObject({ status: "indexed" });
  });

  it("logs ids and reasons, never names or text", async () => {
    const m = await seedMember(pool);
    const lines: string[] = [];
    const { documents } = await queue(m, { log: (line) => lines.push(line) });
    await documents.worker.drain(m.workspaceId);
    expect(lines.join("\n")).not.toMatch(/a\.txt|supplier/);
    expect(lines).toHaveLength(1);
  });

  it("starts and stops a polling loop", async () => {
    const m = await seedMember(pool);
    const { documents, document } = await queue(m);
    documents.worker.start(m.workspaceId);
    for (let i = 0; i < 50 && (await job(document.versionId))?.status !== "indexed"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await documents.worker.stop();
    expect(await job(document.versionId)).toMatchObject({ status: "indexed" });
  });
});
