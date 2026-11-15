import type { Customisation, Rule } from "@legallabs/contracts";
import { tagCode } from "./id.js";
import { lexicalScores, type Scores } from "./lexical.js";
import type { Call } from "./model.js";
import type { ReviewInput, ReviewParagraph } from "./types.js";

/** What every phase reads; built once per review so nothing is recomputed per rule. */
export type Ctx = {
  customisation: Customisation;
  guidance: string | undefined;
  extraContext: string | undefined;
  paragraphs: ReviewParagraph[];
  byIndex: Map<number, ReviewParagraph>;
  position: Map<number, number>;
  /** Non-excluded, non-empty paragraphs: what the review must cover. */
  body: ReviewParagraph[];
  /** In-scope rules by ordinal. */
  rules: Rule[];
  scores: Scores;
  definitions: () => Map<string, number>;
  call: Call;
  newId: () => string;
  /** A fresh tag code per prompt, so no reply or document text can predict it. */
  code: () => string;
  aborted: () => boolean;
  ruleTimeoutMs: number;
};

export function buildCtx(
  input: ReviewInput,
  call: Call,
  newId: () => string,
  ruleTimeoutMs: number,
): Ctx {
  const paragraphs = [...input.paragraphs].sort((a, b) => a.index - b.index);
  const scope = input.customisation.scope === "all" ? null : new Set(input.customisation.scope);
  const rules = input.rules
    .filter((r) => !scope || scope.has(r.id))
    .sort((a, b) => a.ordinal - b.ordinal);
  let defs: Map<string, number> | undefined;
  return {
    customisation: input.customisation,
    guidance: input.guidance,
    extraContext: input.extraContext,
    paragraphs,
    byIndex: new Map(paragraphs.map((p) => [p.index, p])),
    position: new Map(paragraphs.map((p, i) => [p.index, i])),
    body: paragraphs.filter((p) => !p.excluded && p.text.trim()),
    rules,
    scores: lexicalScores(paragraphs, rules),
    definitions: () => {
      defs ??= definitions(paragraphs);
      return defs;
    },
    call,
    newId,
    code: tagCode,
    aborted: () => input.signal?.aborted === true,
    ruleTimeoutMs,
  };
}

/** `"Term"` definitions by paragraph, so in-depth reviews can pull them in. */
export function definitions(paragraphs: readonly ReviewParagraph[]): Map<string, number> {
  const defs = new Map<string, number>();
  for (const p of paragraphs) {
    for (const m of p.text.matchAll(/["“]([A-Z][A-Za-z ]{1,48}[A-Za-z])["”]/g)) {
      const term = m[1];
      if (term && !defs.has(term)) defs.set(term, p.index);
    }
  }
  return defs;
}

export const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function chunk<T>(items: readonly T[], size: (t: T) => number, budget: number): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  let used = 0;
  for (const item of items) {
    const s = size(item);
    if (cur.length > 0 && used + s > budget) {
      out.push(cur);
      cur = [];
      used = 0;
    }
    cur.push(item);
    used += s;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}
