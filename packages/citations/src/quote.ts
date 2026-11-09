export interface Located {
  from: number;
  to: number;
  text: string;
  exact: boolean;
}

export type QuoteResult = { found: true; located: Located } | { found: false };

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

export function locateQuote(page: string, quote: string): QuoteResult {
  const needle = normalize(quote).text;
  for (const reading of pageReadings(page)) {
    const at = reading.text.indexOf(needle);
    if (at < 0) continue;
    const from = reading.starts[at] as number;
    const to = reading.ends[at + needle.length - 1] as number;
    return { found: true, located: { from, to, text: page.slice(from, to), exact: true } };
  }
  return { found: false };
}
