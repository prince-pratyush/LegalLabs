export interface Located {
  from: number;
  to: number;
  text: string;
  exact: boolean;
}

export type QuoteResult =
  | { status: "ok"; located: Located }
  | { status: "mismatch"; reason: "quote_not_found" | "quote_too_short" }
  | { status: "mismatch"; reason: "meaning_changed"; closest: Located };

const MIN_QUOTE_LENGTH = 12;
const MAX_EDIT_RATE = 0.02;
const PROTECTED_WORDS = new Set([
  "and",
  "cannot",
  "except",
  "may",
  "must",
  "neither",
  "never",
  "no",
  "non",
  "none",
  "nor",
  "not",
  "or",
  "shall",
  "unless",
  "without",
]);

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
    let i = 1;
    // Rows past the last active one still count while a run of deletions stays in budget.
    for (; i <= size && (i <= active || upCost < limit); i++) {
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
    active = i - 1;
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
  if (needle.length < MIN_QUOTE_LENGTH) return { status: "mismatch", reason: "quote_too_short" };
  const readings = pageReadings(page);
  for (const reading of readings) {
    const start = reading.text.indexOf(needle);
    if (start < 0) continue;
    const near = { start, end: start + needle.length, distance: 0 };
    return { status: "ok", located: located(page, reading, near) };
  }
  const limit = Math.floor(needle.length * MAX_EDIT_RATE);
  let closest: Located | null = null;
  if (limit > 0) {
    for (const reading of readings) {
      const near = closestMatch(reading.text, needle, limit);
      if (near === null) continue;
      const candidate = located(page, reading, near);
      if (keepsMeaning(needle, reading.text.slice(near.start, near.end))) {
        return { status: "ok", located: candidate };
      }
      closest ??= candidate;
    }
  }
  return closest === null
    ? { status: "mismatch", reason: "quote_not_found" }
    : { status: "mismatch", reason: "meaning_changed", closest };
}

// Scan noise changes letters. It does not change numbers, word counts or these words.
function keepsMeaning(quote: string, found: string): boolean {
  if (numbersIn(quote) !== numbersIn(found)) return false;
  const quoted = quote.split(" ");
  const printed = found.split(" ");
  return (
    quoted.length === printed.length &&
    quoted.every((word, i) => isSameWord(word, printed[i] as string))
  );
}

function numbersIn(text: string): string {
  return text.match(/\d(?:[.,]?\d)*/g)?.join(" ") ?? "";
}

function isSameWord(quoted: string, printed: string): boolean {
  const a = bareWord(quoted);
  const b = bareWord(printed);
  if (a === b) return true;
  if (PROTECTED_WORDS.has(a) || PROTECTED_WORDS.has(b)) return false;
  if (changesPartyRole(a, b)) return false;
  return isWithinOneEdit(a, b) || isWithinOneEdit(undoScanConfusions(a), undoScanConfusions(b));
}

function bareWord(word: string): string {
  return word.toLowerCase().replace(/^\P{L}+|\P{L}+$/gu, "");
}

// Licensor and licensee are one or two letters apart and opposite parties.
function changesPartyRole(a: string, b: string): boolean {
  const suffixA = /(or|er|ee)$/.exec(a)?.[1];
  const suffixB = /(or|er|ee)$/.exec(b)?.[1];
  return suffixA !== undefined && suffixB !== undefined && suffixA !== suffixB;
}

function undoScanConfusions(word: string): string {
  return word.replaceAll("rn", "m").replaceAll("cl", "d").replaceAll("vv", "w");
}

function isWithinOneEdit(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return (
    a.slice(i + 1) === b.slice(i + 1) ||
    a.slice(i + 1) === b.slice(i) ||
    a.slice(i) === b.slice(i + 1)
  );
}
