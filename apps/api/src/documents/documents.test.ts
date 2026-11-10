import type { Ingested, IngestResult } from "@legallabs/ingest";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { Principal } from "../auth/auth.js";
import { auditTrail, type Seeded, seedMember, testPool } from "../test-db.js";
import { createDocuments, type Summary, type UploadResult } from "./documents.js";

const pool = testPool();
afterAll(() => pool.end());

const client = { ip: "203.0.113.9", userAgent: "vitest" };
const encode = (text: string) => new TextEncoder().encode(text);
const asPrincipal = (m: Seeded): Principal => ({
  sessionId: "00000000-0000-7000-8000-000000000000",
  userId: m.userId,
  workspaceId: m.workspaceId,
});

const CLAUSE = "The supplier accepts liability for direct loss.";

function stored(result: UploadResult): Summary {
  if (!result.ok) throw new Error(`expected success, got ${result.reason}`);
  return result.document;
}

async function addMatter(m: Seeded, wallMode = "open") {
  const { rows } = await pool.query<{ id: string }>(
    `insert into core.matter (workspace_id, client_id, client_name, matter_number, matter_name, wall_mode)
     values ($1, 'C1', 'Client', 'M1', 'M1', $2) returning id`,
    [m.workspaceId, wallMode],
  );
  return rows[0]?.id ?? "";
}

describe("upload", () => {
  it("stores a file and lists it for its owner", async () => {
    const m = await seedMember(pool);
    const documents = createDocuments(pool);
    const result = stored(
      await documents.upload(
        asPrincipal(m),
        { name: "msa.txt", bytes: encode(CLAUSE), matterId: null },
        client,
      ),
    );
    expect(result).toMatchObject({
      name: "msa.txt",
      mime: "text/plain",
      size: CLAUSE.length,
      pageCount: 1,
      emptyPageCount: 0,
      matterId: null,
    });
    expect(await documents.list(asPrincipal(m))).toEqual([result]);
  });

  it("keeps the original bytes and their hash", async () => {
    const m = await seedMember(pool);
    const document = stored(
      await createDocuments(pool).upload(
        asPrincipal(m),
        { name: "a.txt", bytes: encode("abc def ghi"), matterId: null },
        client,
      ),
    );
    const { rows } = await pool.query<{ bytes: Buffer; sha: string }>(
      `select b.bytes, encode(v.sha256, 'hex') sha from content.document_blob b
         join content.document_version v on v.id = b.version_id where v.id = $1`,
      [document.versionId],
    );
    expect(rows[0]?.bytes.toString()).toBe("abc def ghi");
    // Worked out separately with `shasum -a 256`.
    expect(rows[0]?.sha).toBe("654dbff2908fd3c0b0e2292799610f8c8119035af54e6251e5fb367cbc4f55dc");
  });

  it("records the upload without the name or any text", async () => {
    const m = await seedMember(pool);
    const document = stored(
      await createDocuments(pool).upload(
        asPrincipal(m),
        { name: "secret-deal.txt", bytes: encode(CLAUSE), matterId: null },
        client,
      ),
    );
    const trail = await auditTrail(pool, m.workspaceId);
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({
      action: "document.uploaded",
      actor_type: "user",
      actor_id: m.userId,
      object_type: "document",
      object_id: document.id,
    });
    expect(JSON.stringify(trail)).not.toMatch(/secret-deal|supplier/);
  });

  it("stores everything from a long document", async () => {
    const m = await seedMember(pool);
    const pages = Array.from({ length: 450 }, (_, i) => ({
      pageNo: i + 1,
      width: 612,
      height: 792,
      text: `Page ${i + 1} text`,
      blocks: [],
    }));
    const chunks = pages.map((p, i) => ({
      ordinal: i,
      pageNo: p.pageNo,
      from: 0,
      to: p.text.length,
      text: p.text,
    }));
    const long: Ingested = { ok: true, mime: "text/plain", pages, chunks, emptyPageCount: 0 };
    const document = stored(
      await createDocuments(pool, { ingest: async () => long }).upload(
        asPrincipal(m),
        { name: "long.txt", bytes: encode("x"), matterId: null },
        client,
      ),
    );
    const { rows } = await pool.query<{ pages: string; chunks: string }>(
      `select (select count(*) from content.page where version_id = $1) pages,
              (select count(*) from content.chunk where version_id = $1) chunks`,
      [document.versionId],
    );
    expect(rows[0]).toEqual({ pages: "450", chunks: "450" });
  });

  it("saves nothing from a file it can't read, and says why", async () => {
    const m = await seedMember(pool);
    const documents = createDocuments(pool);
    const result = await documents.upload(
      asPrincipal(m),
      { name: "contract.docx", bytes: encode("PK"), matterId: null },
      client,
    );
    expect(result).toEqual({ ok: false, reason: "UNSUPPORTED_TYPE" });
    expect(await documents.list(asPrincipal(m))).toEqual([]);
    const trail = await auditTrail(pool, m.workspaceId);
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({
      action: "document.ingest_failed",
      details: { failure_reason: "UNSUPPORTED_TYPE" },
    });
  });

  it("refuses someone without the permission before parsing anything", async () => {
    const m = await seedMember(pool, { permissions: [] });
    const ingest = vi.fn<() => Promise<IngestResult>>();
    const result = await createDocuments(pool, { ingest }).upload(
      asPrincipal(m),
      { name: "a.txt", bytes: encode(CLAUSE), matterId: null },
      client,
    );
    expect(result).toEqual({ ok: false, reason: "FORBIDDEN" });
    expect(ingest).not.toHaveBeenCalled();
  });

  it("files a document on a matter the owner can reach", async () => {
    const m = await seedMember(pool);
    const matterId = await addMatter(m);
    const document = stored(
      await createDocuments(pool).upload(
        asPrincipal(m),
        { name: "a.txt", bytes: encode(CLAUSE), matterId },
        client,
      ),
    );
    expect(document.matterId).toBe(matterId);
  });

  it("answers the same for a walled matter and one that doesn't exist", async () => {
    const m = await seedMember(pool);
    const walled = await addMatter(m, "allow_list");
    const documents = createDocuments(pool);
    const upload = (matterId: string) =>
      documents.upload(asPrincipal(m), { name: "a.txt", bytes: encode(CLAUSE), matterId }, client);
    const missing = "00000000-0000-7000-8000-000000000001";
    expect(await upload(walled)).toEqual({ ok: false, reason: "MATTER_NOT_FOUND" });
    expect(await upload(missing)).toEqual({ ok: false, reason: "MATTER_NOT_FOUND" });
  });
});

describe("search", () => {
  const add = async (m: Seeded, text: string, matterId: string | null = null) =>
    stored(
      await createDocuments(pool).upload(
        asPrincipal(m),
        { name: "a.txt", bytes: encode(text), matterId },
        client,
      ),
    );
  const search = createDocuments(pool).search;

  it("returns the passage, where it is, and which document it came from", async () => {
    const m = await seedMember(pool);
    const document = await add(m, `Intro paragraph.\n\n${"filler ".repeat(300)}\n\n${CLAUSE}`);
    const [passage] = await search(asPrincipal(m), "liability");
    expect(passage).toMatchObject({
      documentId: document.id,
      documentVersionId: document.versionId,
      documentName: "a.txt",
      page: 1,
    });
    expect(passage?.text).toContain(CLAUSE);
  });

  it("matches other forms of a word", async () => {
    const m = await seedMember(pool);
    await add(m, "The parties terminated the agreement.");
    expect(await search(asPrincipal(m), "termination")).toHaveLength(1);
  });

  it("puts the closest match first", async () => {
    const m = await seedMember(pool);
    const weak = await add(m, "Indemnity is mentioned once here among unrelated words.");
    const strong = await add(m, "Indemnity. Indemnity limits. The indemnity cap on indemnity.");
    const passages = await search(asPrincipal(m), "indemnity");
    expect(passages.map((p) => p.documentId)).toEqual([strong.id, weak.id]);
  });

  it("finds nothing in another person's documents", async () => {
    const m = await seedMember(pool);
    const other = await seedMember(pool);
    await add(other, CLAUSE);
    expect(await search(asPrincipal(m), "liability")).toEqual([]);
  });

  it("stops finding a document once a wall shuts its owner out", async () => {
    const m = await seedMember(pool);
    const matterId = await addMatter(m);
    await add(m, CLAUSE, matterId);
    expect(await search(asPrincipal(m), "liability")).toHaveLength(1);
    await pool.query(
      `insert into core.wall (workspace_id, matter_id, principal_type, principal_id, effect)
       values ($1, $2, 'user', $3, 'deny')`,
      [m.workspaceId, matterId, m.userId],
    );
    expect(await search(asPrincipal(m), "liability")).toEqual([]);
  });

  it("can be limited to chosen documents", async () => {
    const m = await seedMember(pool);
    const wanted = await add(m, CLAUSE);
    await add(m, CLAUSE);
    const passages = await search(asPrincipal(m), "liability", { documentIds: [wanted.id] });
    expect(passages.map((p) => p.documentId)).toEqual([wanted.id]);
  });

  it("returns at most the number asked for", async () => {
    const m = await seedMember(pool);
    await add(m, CLAUSE);
    await add(m, CLAUSE);
    await add(m, CLAUSE);
    expect(await search(asPrincipal(m), "liability", { limit: 2 })).toHaveLength(2);
  });

  it("copes with a query of only common words or stray punctuation", async () => {
    const m = await seedMember(pool);
    await add(m, CLAUSE);
    expect(await search(asPrincipal(m), "the and of")).toEqual([]);
    expect(await search(asPrincipal(m), `"liab -( OR &&& :*`)).toEqual([]);
  });

  it("finds nothing for someone who has lost the permission", async () => {
    const m = await seedMember(pool);
    await add(m, CLAUSE);
    await pool.query(
      "update core.role set permissions = '{}' where workspace_id = $1",
      [m.workspaceId],
    );
    expect(await search(asPrincipal(m), "liability")).toEqual([]);
  });
});

describe("list", () => {
  it("shows the newest first, and only your own", async () => {
    const m = await seedMember(pool);
    const other = await seedMember(pool);
    const documents = createDocuments(pool);
    const add = (who: Seeded, name: string) =>
      documents.upload(asPrincipal(who), { name, bytes: encode(CLAUSE), matterId: null }, client);
    await add(m, "first.txt");
    await add(m, "second.txt");
    await add(other, "theirs.txt");
    expect((await documents.list(asPrincipal(m))).map((d) => d.name)).toEqual([
      "second.txt",
      "first.txt",
    ]);
  });
});
