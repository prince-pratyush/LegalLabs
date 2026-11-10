import { type Sources, verifyCitation } from "@legallabs/citations";
import { boxesFor, type Ingested, type IngestResult } from "@legallabs/ingest";
import { makePdf } from "@legallabs/ingest/testing";
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

  it("refuses cleanly if the permission goes while the file is parsing", async () => {
    const m = await seedMember(pool);
    const ingest = async (): Promise<IngestResult> => {
      await pool.query("update core.role set permissions = '{}' where workspace_id = $1", [
        m.workspaceId,
      ]);
      return { ok: true, mime: "text/plain", pages: [], chunks: [], emptyPageCount: 0 };
    };
    const result = await createDocuments(pool, { ingest }).upload(
      asPrincipal(m),
      { name: "a.txt", bytes: encode(CLAUSE), matterId: null },
      client,
    );
    expect(result).toEqual({ ok: false, reason: "FORBIDDEN" });
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

  it("can match any word, so a whole question still finds a passage", async () => {
    const m = await seedMember(pool);
    await add(m, "The parties terminated the agreement.");
    const question = "what happens on termination of the deal";
    expect(await search(asPrincipal(m), question)).toEqual([]);
    expect(await search(asPrincipal(m), question, { match: "any" })).toHaveLength(1);
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

  // A later caller will pass terms and ids chosen by a model.
  it("doesn't fail on bad input from a caller inside the server", async () => {
    const m = await seedMember(pool);
    const principal = asPrincipal(m);
    await add(m, CLAUSE);
    expect(await search(principal, "liab\0ility")).toHaveLength(1);
    expect(await search(principal, "liability", { documentIds: ["not-a-uuid"] })).toEqual([]);
    expect(await search(principal, "liability", { limit: -5 })).toHaveLength(1);
    expect(await search(principal, "liability", { limit: 1.5 })).toHaveLength(1);
  });

  it("finds nothing for someone who has lost the permission", async () => {
    const m = await seedMember(pool);
    await add(m, CLAUSE);
    await pool.query("update core.role set permissions = '{}' where workspace_id = $1", [
      m.workspaceId,
    ]);
    expect(await search(asPrincipal(m), "liability")).toEqual([]);
  });
});

describe("page", () => {
  it("gives the verifier the text a search passage came from", async () => {
    const m = await seedMember(pool);
    const documents = createDocuments(pool);
    const principal = asPrincipal(m);
    const bytes = makePdf([
      ["Cover page of the agreement."],
      ["Recitals come first.", "", "The supplier accepts liability", "for direct loss in full."],
    ]);
    stored(await documents.upload(principal, { name: "msa.pdf", bytes, matterId: null }, client));

    const [passage] = await documents.search(principal, "liability");
    if (!passage) throw new Error("no passage");
    expect(passage.page).toBe(2);

    const sources = {
      documentPage: async (versionId: string, page: number) =>
        (await documents.page(principal, versionId, page))?.text ?? null,
    } as Sources;
    const verified = await verifyCitation(
      {
        kind: "document",
        documentVersionId: passage.documentVersionId,
        page: passage.page,
        quote: "accepts liability for direct loss",
      },
      sources,
    );
    if (verified.status !== "ok" || !("located" in verified)) throw new Error("not verified");

    const page = await documents.page(principal, passage.documentVersionId, passage.page);
    expect(page?.text.slice(passage.from, passage.to)).toBe(passage.text);
    expect(page?.width).toBe(612);
    const boxes = boxesFor(page?.blocks ?? [], verified.located.from, verified.located.to);
    expect(boxes.map((b) => page?.text.slice(b.from, b.to))).toEqual([
      "The supplier accepts liability",
      "for direct loss in full.",
    ]);
  });

  it("gives nothing for another person's page", async () => {
    const m = await seedMember(pool);
    const other = await seedMember(pool);
    const documents = createDocuments(pool);
    const document = stored(
      await documents.upload(
        asPrincipal(other),
        { name: "a.txt", bytes: encode(CLAUSE), matterId: null },
        client,
      ),
    );
    expect(await documents.page(asPrincipal(other), document.versionId, 1)).not.toBeNull();
    expect(await documents.page(asPrincipal(m), document.versionId, 1)).toBeNull();
  });

  // Citations come from a model, so these values are not to be trusted.
  it.each([
    ["a malformed id", "not-a-uuid", 1],
    ["an id that doesn't exist", "00000000-0000-7000-8000-000000000001", 1],
    ["page zero", null, 0],
    ["a fractional page", null, 1.5],
    ["a page too big for the column", null, 2 ** 40],
    ["a page past the end", null, 2],
  ])("gives nothing for %s", async (_, id, pageNo) => {
    const m = await seedMember(pool);
    const documents = createDocuments(pool);
    const document = stored(
      await documents.upload(
        asPrincipal(m),
        { name: "a.txt", bytes: encode(CLAUSE), matterId: null },
        client,
      ),
    );
    expect(await documents.page(asPrincipal(m), id ?? document.versionId, pageNo)).toBeNull();
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
