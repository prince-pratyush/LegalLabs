import { createHash } from "node:crypto";
import { z } from "zod";

/** bge-m3's size, which the chunk column is fixed to. */
export const DIMENSIONS = 1024;

export interface Embedder {
  /** Stored beside each vector, so a model change can be found and re-indexed. */
  model: string;
  embed(texts: readonly string[]): Promise<number[][]>;
}

export interface Reranker {
  /** One score per text, higher is better. */
  rerank(query: string, texts: readonly string[]): Promise<number[]>;
}

/** Thrown when the model server can't answer, so the caller may retry later. */
export class EmbedUnavailable extends Error {}

export interface ServerOptions {
  url: string;
  model?: string | undefined;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const vectors = z.array(z.array(z.number().finite()).length(DIMENSIONS));

async function post(options: ServerOptions, path: string, body: unknown): Promise<unknown> {
  const send = options.fetch ?? fetch;
  try {
    const res = await send(`${options.url.replace(/\/+$/, "")}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs ?? 120_000),
    });
    if (!res.ok) {
      await res.body?.cancel();
      // The body can echo the input, so only the status is kept.
      throw new EmbedUnavailable(`model server answered ${res.status}`);
    }
    return await res.json();
  } catch (err) {
    if (err instanceof EmbedUnavailable) throw err;
    throw new EmbedUnavailable(err instanceof Error ? err.name : "unknown");
  }
}

function checked(raw: unknown, count: number): number[][] {
  const parsed = vectors.safeParse(raw);
  if (!parsed.success || parsed.data.length !== count) {
    throw new EmbedUnavailable("model server gave the wrong shape");
  }
  return parsed.data;
}

/** Text Embeddings Inference, the bundled server. */
export function createTeiEmbedder(options: ServerOptions): Embedder {
  return {
    model: options.model ?? "BAAI/bge-m3",
    async embed(texts) {
      if (texts.length === 0) return [];
      const raw = await post(options, "/embed", { inputs: texts, normalize: true, truncate: true });
      return checked(raw, texts.length);
    },
  };
}

/** Ollama, for a small machine that already runs it. */
export function createOllamaEmbedder(options: ServerOptions): Embedder {
  const model = options.model ?? "bge-m3";
  return {
    model: `ollama:${model}`,
    async embed(texts) {
      if (texts.length === 0) return [];
      const raw = await post(options, "/api/embed", { model, input: texts, truncate: true });
      return checked((raw as { embeddings?: unknown } | null)?.embeddings, texts.length);
    },
  };
}

const ranks = z.array(z.object({ index: z.number().int().min(0), score: z.number().finite() }));

/** bge-reranker served by Text Embeddings Inference. */
export function createTeiReranker(options: ServerOptions): Reranker {
  return {
    async rerank(query, texts) {
      if (texts.length === 0) return [];
      const raw = await post(options, "/rerank", { query, texts, truncate: true });
      const parsed = ranks.safeParse(raw);
      if (!parsed.success) throw new EmbedUnavailable("reranker gave the wrong shape");
      const scores = new Array<number>(texts.length).fill(Number.NEGATIVE_INFINITY);
      for (const { index, score } of parsed.data) if (index < texts.length) scores[index] = score;
      return scores;
    },
  };
}

/**
 * Words hashed into buckets: no meaning, but stable and free. For tests and machines
 * with no model server, where shared words still find each other.
 */
export function createHashEmbedder(): Embedder {
  return {
    model: "hash-v1",
    async embed(texts) {
      return texts.map((text) => {
        const vector = new Array<number>(DIMENSIONS).fill(0);
        for (const word of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
          const bucket = createHash("sha256").update(word).digest().readUInt32BE(0) % DIMENSIONS;
          vector[bucket] = (vector[bucket] ?? 0) + 1;
        }
        const norm = Math.hypot(...vector) || 1;
        return vector.map((value) => value / norm);
      });
    },
  };
}

/** Section first, so a chunk that says "the cap" is found by a question about liability. */
export const contextual = (text: string, section: string | null) =>
  section ? `${section}\n\n${text}` : text;

export function embedderFromEnv(env: Record<string, string | undefined>): Embedder | null {
  if (env.TEI_URL) return createTeiEmbedder({ url: env.TEI_URL, model: env.EMBED_MODEL });
  if (env.OLLAMA_EMBED_URL) {
    return createOllamaEmbedder({ url: env.OLLAMA_EMBED_URL, model: env.EMBED_MODEL });
  }
  return null;
}

/** Off unless asked for, since it adds a model call to every search. */
export function rerankerFromEnv(env: Record<string, string | undefined>): Reranker | null {
  if (env.LEGALLABS_RERANK !== "on" || !env.RERANK_URL) return null;
  return createTeiReranker({ url: env.RERANK_URL });
}
