import { DIMENSIONS, type Embedder, EmbedUnavailable } from "@legallabs/embed";
import type { IngestResult } from "@legallabs/ingest";
import { afterAll, describe, expect, it } from "vitest";
import type { Principal } from "../auth/auth.js";
import { type Seeded, seedMember, testDocuments, testPool } from "../test-db.js";

const pool = testPool();
afterAll(() => pool.end());

const client = { ip: "203.0.113.9", userAgent: "vitest" };
const asPrincipal = (m: Seeded): Principal => ({
  sessionId: "00000000-0000-7000-8000-000000000000",
  userId: m.userId,
  workspaceId: m.workspaceId,
});

const LIABLE = "The supplier shall be liable for direct loss.";
const LAW = "This agreement is governed by the laws of New South Wales.";

// Meaning by lookup: a question about paying for losses lands on the liability clause.
const CONCEPTS: [RegExp, number][] = [
  [/liab|losses|pays/i, 0],
  [/govern|law/i, 1],
];
function conceptEmbedder(model = "concept-v1", seen: string[] = []): Embedder {
  return {
    model,
    async embed(texts) {
      seen.push(...texts);
      return texts.map((text) => {
        const vector = new Array<number>(DIMENSIONS).fill(0);
        const hit = CONCEPTS.find(([pattern]) => pattern.test(text));
        vector[hit ? hit[1] : 2] = 1;
        return vector;
      });
    },
  };
}

async function upload(
  documents: ReturnType<typeof testDocuments>,
  m: Seeded,
  text: string,
  matterId: string | null = null,
) {
  const result = await documents.upload(
    asPrincipal(m),
    { name: "a.txt", bytes: new TextEncoder().encode(text), matterId },
    client,
  );
  if (!result.ok) throw new Error(result.reason);
  return result.document;
}

describe("hybrid search", () => {
  it("finds a passage by meaning when no keyword matches", async () => {
    const m = await seedMember(pool);
    const documents = testDocuments(pool, { embedder: conceptEmbedder() });
    await upload(documents, m, LIABLE);
    await upload(documents, m, LAW);
    const keywordsOnly = testDocuments(pool);
    expect(await keywordsOnly.search(asPrincipal(m), "who pays for losses")).toEqual([]);
    const found = await documents.search(asPrincipal(m), "who pays for losses");
    expect(found[0]?.text).toBe(LIABLE);
  });

  it("ranks a passage both searches found above one only meaning found", async () => {
    const m = await seedMember(pool);
    const documents = testDocuments(pool, { embedder: conceptEmbedder() });
    await upload(documents, m, "The losses clause sits in schedule two.");
    await upload(documents, m, LIABLE);
    const found = await documents.search(asPrincipal(m), "supplier liable", { match: "any" });
    expect(found.map((p) => p.text)).toEqual([LIABLE, "The losses clause sits in schedule two."]);
  });

  it("keeps meaning matches inside the caller's documents and walls", async () => {
    const m = await seedMember(pool);
    const other = await seedMember(pool);
    const embedder = conceptEmbedder();
    const documents = testDocuments(pool, { embedder });
    await upload(documents, other, LIABLE);
    const { rows } = await pool.query<{ id: string }>(
      `insert into core.matter (workspace_id, client_id, client_name, matter_number, matter_name, wall_mode)
       values ($1, 'C1', 'Client', 'M1', 'M1', 'open') returning id`,
      [m.workspaceId],
    );
    const matterId = rows[0]?.id ?? null;
    await upload(documents, m, LIABLE, matterId);
    await pool.query("update core.matter set wall_mode = 'allow_list' where id = $1", [matterId]);
    expect(await documents.search(asPrincipal(m), "who pays for losses")).toEqual([]);
  });

  it("ignores vectors made by another model", async () => {
    const m = await seedMember(pool);
    await upload(testDocuments(pool, { embedder: conceptEmbedder("old-model") }), m, LIABLE);
    const documents = testDocuments(pool, { embedder: conceptEmbedder("new-model") });
    expect(await documents.search(asPrincipal(m), "who pays for losses")).toEqual([]);
  });

  it("falls back to keywords when the model server is down", async () => {
    const m = await seedMember(pool);
    const documents = testDocuments(pool, { embedder: conceptEmbedder() });
    await upload(documents, m, LIABLE);
    const down: Embedder = {
      model: "concept-v1",
      embed: async () => {
        throw new EmbedUnavailable("down");
      },
    };
    const search = testDocuments(pool, { embedder: down }).search;
    expect((await search(asPrincipal(m), "supplier liable"))[0]?.text).toBe(LIABLE);
  });

  it("lets a reranker reorder the candidates, and keeps the order if it fails", async () => {
    const m = await seedMember(pool);
    const embedder = conceptEmbedder();
    const writer = testDocuments(pool, { embedder });
    await upload(writer, m, LIABLE);
    await upload(writer, m, "The supplier is liable only for fraud.");
    const lawLast = async (_: string, texts: readonly string[]) =>
      texts.map((text) => (text.includes("fraud") ? 1 : 0));
    const reranked = testDocuments(pool, { embedder, reranker: { rerank: lawLast } });
    const found = await reranked.search(asPrincipal(m), "supplier liable");
    expect(found[0]?.text).toContain("fraud");
    const broken = testDocuments(pool, {
      embedder,
      reranker: {
        rerank: async () => {
          throw new EmbedUnavailable("down");
        },
      },
    });
    expect(await broken.search(asPrincipal(m), "supplier liable")).toHaveLength(2);
  });
});

describe("indexing with embeddings", () => {
  it("embeds each chunk with its section in front, and records the model", async () => {
    const m = await seedMember(pool);
    const seen: string[] = [];
    const ingest = async (bytes: Uint8Array): Promise<IngestResult> => {
      const text = new TextDecoder().decode(bytes);
      return {
        ok: true,
        mime: "text/plain",
        pages: [{ pageNo: 1, width: 0, height: 0, text, blocks: [] }],
        chunks: [
          { ordinal: 0, pageNo: 1, from: 0, to: text.length, text, section: "7. Liability" },
        ],
        emptyPageCount: 0,
      };
    };
    const documents = testDocuments(pool, {
      embedder: conceptEmbedder("concept-v1", seen),
      ingest,
    });
    const document = await upload(documents, m, LIABLE);
    expect(seen).toEqual([`7. Liability\n\n${LIABLE}`]);
    const { rows } = await pool.query(
      "select embedding_model, vector_dims(embedding) dims from content.chunk where version_id = $1",
      [document.versionId],
    );
    expect(rows).toEqual([{ embedding_model: "concept-v1", dims: DIMENSIONS }]);
  });

  it("waits for the model server rather than index without meaning", async () => {
    const m = await seedMember(pool);
    const down: Embedder = {
      model: "concept-v1",
      embed: async () => {
        throw new EmbedUnavailable("down");
      },
    };
    const documents = testDocuments(pool, { embedder: down, maxAttempts: 2 });
    const document = await upload(documents, m, LIABLE);
    expect(document).toMatchObject({ status: "queued", pageCount: null });
  });
});
