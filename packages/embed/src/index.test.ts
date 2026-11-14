import { describe, expect, it } from "vitest";
import {
  contextual,
  createHashEmbedder,
  createOllamaEmbedder,
  createTeiEmbedder,
  createTeiReranker,
  DIMENSIONS,
  EmbedUnavailable,
  embedderFromEnv,
  rerankerFromEnv,
} from "./index.js";

const vector = (seed: number) => Array.from({ length: DIMENSIONS }, (_, i) => (i === seed ? 1 : 0));

function recording(answer: unknown, status = 200) {
  const calls: { url: string; body: unknown }[] = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify(answer), { status });
  };
  return { calls, fetch: fetch as typeof globalThis.fetch };
}

describe("TEI embedder", () => {
  it("asks for normalised vectors and returns one per text", async () => {
    const { calls, fetch } = recording([vector(0), vector(1)]);
    const embedder = createTeiEmbedder({ url: "http://tei/", fetch });
    expect(await embedder.embed(["a", "b"])).toEqual([vector(0), vector(1)]);
    expect(calls).toEqual([
      { url: "http://tei/embed", body: { inputs: ["a", "b"], normalize: true, truncate: true } },
    ]);
    expect(embedder.model).toBe("BAAI/bge-m3");
  });

  it("refuses vectors of the wrong size or count", async () => {
    const short = createTeiEmbedder({ url: "http://tei", fetch: recording([[1, 2]]).fetch });
    await expect(short.embed(["a"])).rejects.toBeInstanceOf(EmbedUnavailable);
    const few = createTeiEmbedder({ url: "http://tei", fetch: recording([vector(0)]).fetch });
    await expect(few.embed(["a", "b"])).rejects.toBeInstanceOf(EmbedUnavailable);
  });

  it("keeps a failing server's reply out of the error", async () => {
    const down = createTeiEmbedder({
      url: "http://tei",
      fetch: recording("secret text", 500).fetch,
    });
    await expect(down.embed(["a"])).rejects.toThrow(/answered 500$/);
  });

  it("calls nothing for no texts", async () => {
    const { calls, fetch } = recording([]);
    expect(await createTeiEmbedder({ url: "http://tei", fetch }).embed([])).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe("Ollama embedder", () => {
  it("names the model it used", async () => {
    const { calls, fetch } = recording({ embeddings: [vector(3)] });
    const embedder = createOllamaEmbedder({ url: "http://ollama", fetch });
    expect(await embedder.embed(["a"])).toEqual([vector(3)]);
    expect(embedder.model).toBe("ollama:bge-m3");
    expect(calls[0]?.body).toEqual({ model: "bge-m3", input: ["a"], truncate: true });
  });
});

describe("TEI reranker", () => {
  it("puts each score back at its text's position", async () => {
    const { fetch } = recording([
      { index: 1, score: 0.9 },
      { index: 0, score: 0.1 },
    ]);
    const reranker = createTeiReranker({ url: "http://rerank", fetch });
    expect(await reranker.rerank("q", ["a", "b"])).toEqual([0.1, 0.9]);
  });
});

const dot = (x: number[] = [], y: number[] = []) => x.reduce((s, v, i) => s + v * (y[i] ?? 0), 0);

describe("hash embedder", () => {
  it("is stable and puts shared words close", async () => {
    const embedder = createHashEmbedder();
    const [a, b, c] = await embedder.embed([
      "supplier liability cap",
      "the supplier's liability",
      "governing law",
    ]);
    expect(dot(a, b)).toBeGreaterThan(dot(a, c));
    expect(await embedder.embed(["supplier liability cap"])).toEqual([a]);
  });
});

describe("config", () => {
  it("prefixes the section, so a chunk carries its clause", () => {
    expect(contextual("The cap is ten.", "12. Liability > 12.2")).toBe(
      "12. Liability > 12.2\n\nThe cap is ten.",
    );
    expect(contextual("Body.", null)).toBe("Body.");
  });

  it("reads servers from the environment and keeps reranking off unless asked", () => {
    expect(embedderFromEnv({})).toBeNull();
    expect(embedderFromEnv({ TEI_URL: "http://tei" })?.model).toBe("BAAI/bge-m3");
    expect(embedderFromEnv({ OLLAMA_EMBED_URL: "http://o" })?.model).toBe("ollama:bge-m3");
    expect(rerankerFromEnv({ RERANK_URL: "http://r" })).toBeNull();
    expect(rerankerFromEnv({ RERANK_URL: "http://r", LEGALLABS_RERANK: "on" })).not.toBeNull();
  });
});

const ollama = process.env.TEST_OLLAMA_URL;
describe.runIf(ollama)("Ollama bge-m3", () => {
  it("puts a paraphrase nearer than an unrelated clause", async () => {
    const embedder = createOllamaEmbedder({ url: ollama ?? "" });
    const [question, match, other] = await embedder.embed([
      "Who pays if the software causes losses?",
      "The supplier shall be liable for direct loss caused by the software.",
      "This agreement is governed by the laws of New South Wales.",
    ]);
    expect(dot(question, match)).toBeGreaterThan(dot(question, other));
  }, 120_000);
});
