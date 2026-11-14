import { normaliseParagraph } from "@legallabs/contracts";

export type QuoteMatch =
  | { ok: true; char_from: number; char_to: number; text: string }
  | { ok: false; reason: string };

const FOLD: Record<string, string> = {
  "‘": "'",
  "’": "'",
  "“": '"',
  "”": '"',
  "–": "-",
  "—": "-",
  "−": "-",
};

// One output unit per input unit, so folding never moves an offset.
const foldUnit = (c: string) => {
  const f = FOLD[c] ?? c.toLowerCase();
  return f.length === c.length ? f : c;
};
const fold = (s: string) => [...s].map(foldUnit).join("");

// Character classes come from normaliseParagraph itself, so they can't drift from the hash.
const kind = (cp: string): "space" | "invisible" | "text" => {
  if (normaliseParagraph(cp) !== "") return "text";
  return normaliseParagraph(`a${cp}a`) === "a a" ? "space" : "invisible";
};

/**
 * The paragraph normalised one code point at a time, with each normalised UTF-16 unit
 * mapped back to the raw span it came from.
 */
function normaliseWithMap(raw: string) {
  let norm = "";
  const from: number[] = [];
  const to: number[] = [];
  let pendingSpace = -1;
  let r = 0;
  for (const cp of raw) {
    const at = r;
    r += cp.length;
    const k = kind(cp);
    if (k === "invisible") continue;
    if (k === "space") {
      if (norm.length > 0 && pendingSpace === -1) pendingSpace = at;
      continue;
    }
    if (pendingSpace !== -1) {
      norm += " ";
      from.push(pendingSpace);
      to.push(pendingSpace + 1);
      pendingSpace = -1;
    }
    for (const unit of fold(cp.normalize("NFKC")).split("")) {
      norm += unit;
      from.push(at);
      to.push(r);
    }
  }
  return { norm, from, to };
}

const trimQuote = (quote: string) =>
  normaliseParagraph(quote)
    .replace(/^(?:\.\.\.|…|["'“”‘’])+/, "")
    .replace(/(?:\.\.\.|…|["'“”‘’])+$/, "")
    .trim();

/**
 * Finds a model's quote in a paragraph after normalising both. Offsets are UTF-16
 * positions in the raw paragraph text and `text` is that raw slice, so callers store the
 * document's own words. Case, curly quotes, dashes and whitespace are forgiven.
 */
export function verifyQuote(paragraph: string, quote: string): QuoteMatch {
  const q = trimQuote(quote);
  if (q.length < 3) return { ok: false, reason: "quote is empty or too short" };
  const { norm, from, to } = normaliseWithMap(paragraph);
  for (const needle of [q, q.replace(/[.,;:]+$/, "")]) {
    if (needle.length < 3) continue;
    const at = norm.indexOf(fold(needle));
    if (at === -1) continue;
    const start = from[at] ?? 0;
    const end = to[at + needle.length - 1] ?? start;
    return { ok: true, char_from: start, char_to: end, text: paragraph.slice(start, end) };
  }
  return { ok: false, reason: "quote not found in paragraph" };
}
