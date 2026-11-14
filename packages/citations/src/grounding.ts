import type { CitationStatus } from "./verify.js";

export type Range = readonly [from: number, to: number];

// Saying a thing wasn't found is the honest answer, not an unsupported claim.
const NOT_FOUND =
  /\b(?:couldn'?t|could not|can'?t|cannot|did not|didn'?t|unable to) (?:find|locate|confirm)\b|\b(?:not|wasn'?t|isn'?t) (?:found|mentioned|addressed|stated|specified|covered)\b|\bno (?:information|mention|reference)\b|\bdo(?:es)? not (?:say|mention|address|state|specify)\b/i;

const MIN_WORDS = 4;

/** Sentence spans, each including its closing punctuation. */
export function sentences(text: string): Range[] {
  const spans: Range[] = [];
  // Ends at . ! ? or a line break; a full stop inside a number or initial (12.2, e.g.) doesn't end one.
  const end = /[.!?]+(?=["'”’)\]]*(?:\s|$))|\n/g;
  let from = 0;
  for (const match of text.matchAll(end)) {
    const to = match.index + match[0].length;
    const previous = text.slice(Math.max(from, match.index - 3), match.index);
    if (match[0] === "." && /(?:^|\s)(?:[A-Za-z]|e\.g|i\.e|cl|No|v|s|ss|para)$/.test(previous)) {
      continue;
    }
    push(from, to);
    from = to;
  }
  push(from, text.length);
  return spans;

  function push(start: number, stop: number) {
    let a = start;
    let b = stop;
    while (a < b && /\s/.test(text[a] ?? "")) a++;
    while (b > a && /\s/.test(text[b - 1] ?? "")) b--;
    if (b > a) spans.push([a, b]);
  }
}

/**
 * Sentences that make a claim without a verified citation. A citation belongs
 * to the sentence just before it, which is where the prompt asks models to put it.
 */
export function ungroundedSentences(
  text: string,
  citations: readonly { at: number; status: CitationStatus }[],
): Range[] {
  const spans = sentences(text);
  const supported = new Set<number>();
  for (const citation of citations) {
    if (citation.status !== "ok") continue;
    let owner = -1;
    for (const [i, [from]] of spans.entries()) {
      if (from < Math.max(citation.at, 1)) owner = i;
    }
    if (owner !== -1) supported.add(owner);
  }
  return spans.filter(([from, to], i) => {
    if (supported.has(i)) return false;
    const sentence = text.slice(from, to);
    if (sentence.trimEnd().endsWith("?") || sentence.trimEnd().endsWith(":")) return false;
    if (sentence.split(/\s+/).length < MIN_WORDS) return false;
    return !NOT_FOUND.test(sentence);
  });
}
