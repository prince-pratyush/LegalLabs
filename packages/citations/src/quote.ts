export interface Located {
  from: number;
  to: number;
  text: string;
  exact: boolean;
}

export type QuoteFailure = "quote_not_found" | "quote_too_short";

export type QuoteResult =
  | { found: true; located: Located }
  | { found: false; reason: QuoteFailure };

const MIN_QUOTE_LENGTH = 12;
const MAX_EDIT_RATE = 0.02;

interface Normalized {
  text: string;
  // Original offsets of each normalised character, so a match maps back to the real page.
  starts: number[];
  ends: number[];
}

const LIGATURES: Record<string, string> = {
  ﬀ: "ff",
  ﬁ: "fi",
  ﬂ: "fl",
  ﬃ: "ffi",
  ﬄ: "ffl",
  ﬅ: "st",
  ﬆ: "st",
};

function fold(cluster: string): string {
  const composed = cluster.normalize("NFC");
  return (
    LIGATURES[composed] ??
    composed
      .replace(/[­​-‍⁠﻿]/g, "")
      .replace(/[‘’‚‛′]/g, "'")
      .replace(/[“”„‟″]/g, '"')
  );
}

function normalize(raw: string, skipped: ReadonlySet<number> = new Set()): Normalized {
  let text = "";
  const starts: number[] = [];
  const ends: number[] = [];
  for (const match of raw.matchAll(/\P{M}\p{M}*/gu)) {
    const start = match.index;
    if (skipped.has(start)) continue;
    const end = start + match[0].length;
    for (const char of fold(match[0])) {
      if (/\s/.test(char)) {
        if (text.length === 0) continue;
        if (text.endsWith(" ")) {
          ends[ends.length - 1] = end;
          continue;
        }
        text += " ";
      } else {
        text += char;
      }
      for (let unit = 0; unit < char.length; unit++) {
        starts.push(start);
        ends.push(end);
      }
    }
  }
  if (text.endsWith(" ")) {
    text = text.slice(0, -1);
    starts.pop();
    ends.pop();
  }
  return { text, starts, ends };
}

// A hyphen before a line break is ambiguous: "lia-\nbility" is one word, "cost-\nbenefit" keeps it.
function pageReadings(page: string): Normalized[] {
  const breaks = [...page.matchAll(/(?<=\p{L})[-­‐][^\S\n]*\n\s*(?=\p{Ll})/gu)];
  if (breaks.length === 0) return [normalize(page)];
  const joined = new Set<number>();
  const hyphenated = new Set<number>();
  for (const found of breaks) {
    for (let i = found.index; i < found.index + found[0].length; i++) {
      joined.add(i);
      if (i > found.index) hyphenated.add(i);
    }
  }
  return [normalize(page, joined), normalize(page, hyphenated)];
}

interface Near {
  start: number;
  end: number;
  distance: number;
}

// Sellers' search with Ukkonen's cut-off, so a 5 MB page stays linear in the edit limit.
function closestMatch(text: string, pattern: string, limit: number): Near | null {
  const size = pattern.length;
  const cost = Int32Array.from({ length: size + 1 }, (_, i) => i);
  const begin = new Int32Array(size + 1);
  let active = limit;
  let best: Near | null = null;
  for (let j = 0; j < text.length; j++) {
    let diagCost = 0;
    let diagStart = j;
    let upCost = 0;
    let upStart = j + 1;
    for (let i = 1; i <= active; i++) {
      const leftCost = cost[i] as number;
      const leftStart = begin[i] as number;
      let value = diagCost + (pattern.charCodeAt(i - 1) === text.charCodeAt(j) ? 0 : 1);
      let start = diagStart;
      if (leftCost + 1 < value) {
        value = leftCost + 1;
        start = leftStart;
      }
      if (upCost + 1 < value) {
        value = upCost + 1;
        start = upStart;
      }
      cost[i] = value;
      begin[i] = start;
      diagCost = leftCost;
      diagStart = leftStart;
      upCost = value;
      upStart = start;
    }
    while ((cost[active] as number) > limit) active--;
    if (active < size) {
      active++;
      continue;
    }
    const near = { start: begin[size] as number, end: j + 1, distance: cost[size] as number };
    if (best === null || isCloser(near, best, size)) best = near;
  }
  return best;
}

function isCloser(a: Near, b: Near, size: number): boolean {
  if (a.distance !== b.distance) return a.distance < b.distance;
  return Math.abs(a.end - a.start - size) < Math.abs(b.end - b.start - size);
}

function located(page: string, reading: Normalized, near: Near): Located {
  const from = reading.starts[near.start] as number;
  const to = reading.ends[near.end - 1] as number;
  return { from, to, text: page.slice(from, to), exact: near.distance === 0 };
}

export function locateQuote(page: string, quote: string): QuoteResult {
  const needle = normalize(quote).text;
  if (needle.length < MIN_QUOTE_LENGTH) return { found: false, reason: "quote_too_short" };
  const readings = pageReadings(page);
  for (const reading of readings) {
    const start = reading.text.indexOf(needle);
    if (start < 0) continue;
    const near = { start, end: start + needle.length, distance: 0 };
    return { found: true, located: located(page, reading, near) };
  }
  const limit = Math.floor(needle.length * MAX_EDIT_RATE);
  if (limit > 0) {
    for (const reading of readings) {
      const near = closestMatch(reading.text, needle, limit);
      if (near !== null) return { found: true, located: located(page, reading, near) };
    }
  }
  return { found: false, reason: "quote_not_found" };
}
