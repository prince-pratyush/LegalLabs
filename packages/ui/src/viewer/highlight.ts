import type { PageLine } from "@legallabs/contracts";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Boxes over the characters `from` to `to`, in PDF points. Line boxes carry no
 * per-glyph positions, so a partly covered line is cut in proportion to its characters.
 */
export function rectsFor(lines: readonly PageLine[], from: number, to: number): Rect[] {
  const rects: Rect[] = [];
  for (const line of lines) {
    if (line.to <= from || line.from >= to || line.to <= line.from) continue;
    const span = line.to - line.from;
    const width = line.x1 - line.x0;
    const start = (Math.max(from, line.from) - line.from) / span;
    const end = (Math.min(to, line.to) - line.from) / span;
    rects.push({
      x: line.x0 + width * start,
      y: line.y0,
      width: width * (end - start),
      height: line.y1 - line.y0,
    });
  }
  return rects;
}

// Folds the differences a model or OCR introduces without changing the words.
const FOLD: Record<string, string> = {
  "‘": "'",
  "’": "'",
  "“": '"',
  "”": '"',
  "–": "-",
  "—": "-",
  "­": "",
  ﬁ: "fi",
  ﬂ: "fl",
};

/** Text with whitespace and look-alike characters folded, and where each kept character came from. */
export function normalise(text: string): { text: string; at: number[] } {
  let out = "";
  const at: number[] = [];
  let space = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i] ?? "";
    if (/\s/.test(char)) {
      space = out.length > 0;
      continue;
    }
    if (space) {
      out += " ";
      at.push(i);
      space = false;
    }
    const folded = FOLD[char] ?? char.toLowerCase();
    for (const piece of folded) {
      out += piece;
      at.push(i);
    }
  }
  return { text: out, at };
}

function bigrams(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (let i = 0; i < text.length - 1; i++) {
    const pair = text.slice(i, i + 2);
    counts.set(pair, (counts.get(pair) ?? 0) + 1);
  }
  return counts;
}

function similarity(a: Map<string, number>, b: Map<string, number>, total: number): number {
  let shared = 0;
  for (const [pair, count] of a) shared += Math.min(count, b.get(pair) ?? 0);
  return total === 0 ? 0 : (2 * shared) / total;
}

export interface Located {
  from: number;
  to: number;
  /** False when only a close match was found, so the highlight is drawn as approximate. */
  exact: boolean;
}

export const APPROXIMATE = 0.9;

/** Finds a quote on a page when its offsets are missing or didn't verify. */
export function locateQuote(page: string, quote: string): Located | null {
  const hay = normalise(page);
  const needle = normalise(quote).text;
  if (needle.length < 4) return null;
  const exact = hay.text.indexOf(needle);
  if (exact >= 0) {
    const last = hay.at[exact + needle.length - 1] ?? 0;
    return { from: hay.at[exact] ?? 0, to: last + 1, exact: true };
  }
  // Slides a window the quote's length over the page, word start by word start.
  const target = bigrams(needle);
  const n = needle.length;
  let best = { score: 0, start: -1 };
  for (let i = 0; i + n <= hay.text.length + 4; i++) {
    if (i > 0 && hay.text[i - 1] !== " ") continue;
    const window = hay.text.slice(i, i + n);
    const score = similarity(target, bigrams(window), n - 1 + window.length - 1);
    if (score > best.score) best = { score, start: i };
  }
  if (best.score < APPROXIMATE) return null;
  const end = Math.min(best.start + n, hay.text.length) - 1;
  return { from: hay.at[best.start] ?? 0, to: (hay.at[end] ?? 0) + 1, exact: false };
}
