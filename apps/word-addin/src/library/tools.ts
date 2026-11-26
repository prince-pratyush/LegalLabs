import type { Api } from "../api.js";
import { type Card, sortCards } from "../cards/card.js";
import { paraHash } from "../edits/anchor.js";
import type { Scope, WordHost } from "../office/host.js";

// The API's per-request limits; a long document goes as several requests.
export const MAX_BATCH_CHARS = 6_000;
export const MAX_BATCH_PARAGRAPHS = 100;

export type Batch = { indexes: number[]; texts: string[] };

/** Groups non-empty paragraphs into requests; a paragraph too long for any request is left out. */
export function batches(paragraphs: readonly string[]): { batches: Batch[]; skipped: number } {
  const out: Batch[] = [];
  let current: Batch = { indexes: [], texts: [] };
  let size = 0;
  let skipped = 0;
  for (const [index, text] of paragraphs.entries()) {
    if (!text.trim()) continue;
    if (text.length > MAX_BATCH_CHARS) {
      skipped++;
      continue;
    }
    if (size + text.length > MAX_BATCH_CHARS || current.texts.length === MAX_BATCH_PARAGRAPHS) {
      out.push(current);
      current = { indexes: [], texts: [] };
      size = 0;
    }
    current.indexes.push(index);
    current.texts.push(text);
    size += text.length;
  }
  if (current.texts.length > 0) out.push(current);
  return { batches: out, skipped };
}

/**
 * Where the selection's paragraphs start in the document, so a fix found in a selection
 * is anchored like one found in the whole document. Null when they can't be placed.
 */
export function offsetOf(document: readonly string[], selection: readonly string[]): number | null {
  if (selection.length === 0) return null;
  const fits = (start: number) => selection.every((text, i) => document[start + i] === text);
  const starts = document.flatMap((_, i) => (fits(i) ? [i] : []));
  return starts.length === 1 ? (starts[0] ?? null) : null;
}

type Progress = (done: number, total: number) => void;

async function inDocument(host: WordHost, scope: Scope) {
  const scoped = await host.read(scope);
  if (scope === "document") return { paragraphs: scoped.paragraphs, offset: 0 };
  const whole = await host.read("document");
  return { paragraphs: scoped.paragraphs, offset: offsetOf(whole.paragraphs, scoped.paragraphs) };
}

/** Proofread suggestions as cards, anchored to document paragraphs. */
export async function proofread(
  api: Api,
  host: WordHost,
  scope: Scope,
  onProgress: Progress,
): Promise<{ cards: Card[]; skipped: number }> {
  const { paragraphs, offset } = await inDocument(host, scope);
  const plan = batches(paragraphs);
  const cards: Card[] = [];
  const batchId = crypto.randomUUID();
  for (const [i, batch] of plan.batches.entries()) {
    onProgress(i, plan.batches.length);
    const { suggestions } = await api.post<{
      suggestions: { paragraph: number; before: string; after: string; reason: string }[];
    }>("/api/v1/addin/proofread", { paragraphs: batch.texts, batch_id: batchId });
    for (const s of suggestions) {
      const local = batch.indexes[s.paragraph];
      const text = batch.texts[s.paragraph];
      if (local === undefined || text === undefined) continue;
      cards.push({
        id: crypto.randomUUID(),
        kind: "proofread",
        title: s.reason || "Proofread",
        // Unplaced selections still apply: the anchor misses and Word searches for the text.
        anchor: { paragraph_index: (offset ?? -100) + local, para_hash: await paraHash(text) },
        before: s.before,
        after: s.after,
        justification: "",
        state: "pending",
        flag: false,
        ruleId: null,
      });
    }
  }
  onProgress(plan.batches.length, plan.batches.length);
  return { cards: sortCards(cards), skipped: plan.skipped };
}

/** Translates paragraph by paragraph and writes the result back, tracked when `showEdits`. */
export async function translate(
  api: Api,
  host: WordHost,
  scope: Scope,
  language: string,
  showEdits: boolean,
  onProgress: Progress,
): Promise<{ changed: number; missed: number; skipped: number }> {
  const { paragraphs } = await host.read(scope);
  const plan = batches(paragraphs);
  const edits: { index: number; text: string }[] = [];
  let missed = 0;
  const batchId = crypto.randomUUID();
  for (const [i, batch] of plan.batches.entries()) {
    onProgress(i, plan.batches.length);
    const result = await api.post<{ paragraphs: (string | null)[] }>("/api/v1/addin/translate", {
      paragraphs: batch.texts,
      language,
      batch_id: batchId,
      last: i === plan.batches.length - 1,
    });
    for (const [j, index] of batch.indexes.entries()) {
      const text = result.paragraphs[j];
      if (text) edits.push({ index, text });
      else missed++;
    }
  }
  onProgress(plan.batches.length, plan.batches.length);
  const changed = await host.rewrite(scope, edits, showEdits);
  return { changed, missed, skipped: plan.skipped };
}
