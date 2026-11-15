import type { Rule } from "@legallabs/contracts";
import type { ReviewParagraph } from "./types.js";

const STOP = new Set(
  (
    "the a an and or of to in on for by with as at be is are was were this that these those " +
    "any all such shall will may must not no its it their them party parties agreement " +
    "which who whom from under upon other than into within without each per has have had " +
    "been being if then so also only more most less our your we us you including include"
  ).split(" "),
);

/** Lowercased content words cut to a 6-letter prefix, so "terminates" meets "termination". */
export function terms(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().match(/[a-z][a-z0-9]+/g) ?? []) {
    if (raw.length < 3 || STOP.has(raw)) continue;
    out.push(stem(raw));
  }
  return out;
}

const stem = (w: string) => (w.length > 4 ? w.replace(/s$/, "") : w).slice(0, 6);

type Posting = { doc: number; tf: number };

/** Inverted index over body paragraphs; built once per review. */
type Index = {
  docs: { index: number; len: number }[];
  postings: Map<string, Posting[]>;
  headings: Map<string, number[]>;
  avg: number;
};

function buildIndex(paragraphs: readonly ReviewParagraph[]): Index {
  const postings = new Map<string, Posting[]>();
  const headings = new Map<string, number[]>();
  const docs = paragraphs.map((p, doc) => {
    const ts = terms(p.text);
    const tf = new Map<string, number>();
    for (const t of ts) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const [t, n] of tf) {
      const list = postings.get(t) ?? [];
      list.push({ doc, tf: n });
      postings.set(t, list);
    }
    for (const t of new Set(terms(p.section_path ?? ""))) {
      const list = headings.get(t) ?? [];
      list.push(doc);
      headings.set(t, list);
    }
    return { index: p.index, len: ts.length };
  });
  const avg = docs.reduce((s, d) => s + d.len, 0) / Math.max(docs.length, 1) || 1;
  return { docs, postings, headings, avg };
}

/** Query terms: the title counts double, then the standard position and a little sample text. */
function ruleQuery(rule: Rule): Map<string, number> {
  const q = new Map<string, number>();
  const add = (text: string | undefined, w: number) => {
    for (const t of new Set(terms(text ?? ""))) q.set(t, Math.max(q.get(t) ?? 0, w));
  };
  add(rule.sample_language?.slice(0, 400), 0.5);
  add(rule.standard_position, 1);
  add(rule.title, 2);
  return q;
}

/** Rule id → paragraph index → score. */
export type Scores = Map<string, Map<number, number>>;

/**
 * BM25 of each paragraph against each rule, plus a bonus when the section heading carries a
 * title word. Excluded and empty paragraphs score 0.
 */
export function lexicalScores(
  paragraphs: readonly ReviewParagraph[],
  rules: readonly Rule[],
): Scores {
  const idx = buildIndex(paragraphs.filter((p) => !p.excluded && p.text.trim()));
  const n = idx.docs.length;
  const k1 = 1.2;
  const b = 0.75;
  const out: Scores = new Map();
  for (const rule of rules) {
    const acc = new Map<number, number>();
    for (const [t, w] of ruleQuery(rule)) {
      const list = idx.postings.get(t);
      if (!list) continue;
      const idf = Math.log(1 + (n - list.length + 0.5) / (list.length + 0.5));
      for (const { doc, tf } of list) {
        const len = idx.docs[doc]?.len ?? 0;
        const s = (w * idf * (tf * (k1 + 1))) / (tf + k1 * (1 - b + (b * len) / idx.avg));
        acc.set(doc, (acc.get(doc) ?? 0) + s);
      }
    }
    for (const t of new Set(terms(rule.title)))
      for (const doc of idx.headings.get(t) ?? []) acc.set(doc, (acc.get(doc) ?? 0) + 1.5);
    const scores = new Map<number, number>();
    for (const [doc, s] of acc) {
      const d = idx.docs[doc];
      if (d && s > 0) scores.set(d.index, s);
    }
    out.set(rule.id, scores);
  }
  return out;
}

export type LexicalOptions = {
  /** Paragraphs kept per rule. */
  topK?: number;
  /** Keep only paragraphs scoring at least this share of the rule's best. */
  relative?: number;
  /** Below this absolute score a rule's best paragraph is noise, not a match. */
  minScore?: number;
};

/** A rule → paragraphs map from lexical scores alone; the fallback when the model fails. */
export function lexicalMap(
  paragraphs: readonly ReviewParagraph[],
  rules: readonly Rule[],
  opts: LexicalOptions = {},
  scores: Scores = lexicalScores(paragraphs, rules),
): { clause_map: Record<string, number[]>; uncovered: number[] } {
  const { topK = 4, relative = 0.5, minScore = 2 } = opts;
  const clause_map: Record<string, number[]> = {};
  const covered = new Set<number>();
  for (const rule of rules) {
    const ranked = [...(scores.get(rule.id) ?? new Map<number, number>())].sort(
      (a, b) => b[1] - a[1],
    );
    const best = ranked[0]?.[1] ?? 0;
    const keep =
      best < minScore
        ? []
        : ranked
            .filter(([, s]) => s >= best * relative)
            .slice(0, topK)
            .map(([i]) => i);
    keep.sort((a, b) => a - b);
    clause_map[rule.id] = keep;
    for (const i of keep) covered.add(i);
  }
  const uncovered = paragraphs
    .filter((p) => !p.excluded && p.text.trim() && !covered.has(p.index))
    .map((p) => p.index);
  return { clause_map, uncovered };
}

/**
 * The paragraph most like the rule, for anchoring an insertion when the clause is missing.
 * Undefined when nothing scores: an insertion after an arbitrary paragraph would mislead.
 */
export function mostRelated(
  scores: Map<number, number> | undefined,
  paragraphs: readonly ReviewParagraph[],
): ReviewParagraph | undefined {
  const body = paragraphs.filter((p) => !p.excluded && p.text.trim());
  let best: ReviewParagraph | undefined;
  let bestScore = 0;
  for (const p of body) {
    const s = scores?.get(p.index) ?? 0;
    if (s > bestScore) {
      best = p;
      bestScore = s;
    }
  }
  return best;
}
