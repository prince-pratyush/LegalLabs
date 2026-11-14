export type CitationStatus = "ok" | "mismatch" | "unresolved";

export type AnswerCitation = {
  n: number;
  /** Where the marker sits in the text, as a character offset. */
  at: number;
  status: CitationStatus;
  documentName: string | null;
  page: number | null;
  quote: string | null;
};

/** A half-open character range the verifier found no support for. */
export type Range = readonly [from: number, to: number];

export type AnswerPart =
  | { kind: "text"; text: string; ungrounded: boolean }
  | { kind: "citation"; citation: AnswerCitation }
  | { kind: "pending"; n: number };

const PLACEHOLDER = /\[\[c:(\d+)\]\]/g;

/**
 * Cuts an answer into text runs and markers. Streaming text carries `[[c:N]]`
 * where a citation will go; it becomes a marker once citation N has arrived.
 */
export function splitAnswer(
  text: string,
  citations: readonly AnswerCitation[],
  ungrounded: readonly Range[] = [],
): AnswerPart[] {
  const unplaced = new Map(citations.map((c) => [c.n, c]));
  // Placeholders come out of the text, so all offsets below are in the clean text.
  let plain = "";
  const marks: { at: number; part: AnswerPart }[] = [];
  let last = 0;
  for (const match of text.matchAll(PLACEHOLDER)) {
    plain += text.slice(last, match.index);
    const n = Number(match[1]);
    const citation = unplaced.get(n);
    marks.push({
      at: plain.length,
      part: citation ? { kind: "citation", citation } : { kind: "pending", n },
    });
    unplaced.delete(n);
    last = match.index + match[0].length;
  }
  plain += text.slice(last);
  for (const citation of unplaced.values()) {
    const at = Math.min(Math.max(citation.at, 0), plain.length);
    marks.push({ at, part: { kind: "citation", citation } });
  }
  // Stable, so markers at one offset keep their order.
  marks.sort((a, b) => a.at - b.at);

  const clamp = (n: number) => Math.max(0, Math.min(n, plain.length));
  const cuts = new Set<number>([0, plain.length]);
  for (const mark of marks) cuts.add(mark.at);
  for (const [from, to] of ungrounded) {
    cuts.add(clamp(from));
    cuts.add(clamp(to));
  }
  const points = [...cuts].sort((a, b) => a - b);
  const flagged = (at: number) => ungrounded.some(([from, to]) => at >= from && at < to);

  const parts: AnswerPart[] = [];
  let m = 0;
  for (const [i, at] of points.entries()) {
    for (let mark = marks[m]; mark && mark.at === at; mark = marks[++m]) parts.push(mark.part);
    const next = points[i + 1];
    if (next === undefined) continue;
    const run = plain.slice(at, next);
    const ungroundedRun = flagged(at);
    const prev = parts.at(-1);
    if (prev?.kind === "text" && prev.ungrounded === ungroundedRun) prev.text += run;
    else parts.push({ kind: "text", text: run, ungrounded: ungroundedRun });
  }
  return parts;
}
