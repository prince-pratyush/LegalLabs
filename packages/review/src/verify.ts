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

type Kind = "space" | "invisible" | "text";
const kinds = new Map<string, Kind>();

// Classes come from normaliseParagraph itself, so they can't drift from the hash. Printable
// ASCII is decided inline and the rest is memoised: this runs once per code point.
const kind = (cp: string): Kind => {
  const c = cp.charCodeAt(0);
  if (cp.length === 1 && c > 0x20 && c < 0x7f) return "text";
  if (cp === " ") return "space";
  let k = kinds.get(cp);
  if (!k) {
    if (normaliseParagraph(cp) !== "") k = "text";
    else k = normaliseParagraph(`a${cp}a`) === "a a" ? "space" : "invisible";
    kinds.set(cp, k);
  }
  return k;
};

type Mapped = { norm: string; from: number[]; to: number[] };

/**
 * The paragraph normalised one code point at a time, with each normalised UTF-16 unit
 * mapped back to the raw span it came from.
 */
function normaliseWithMap(raw: string): Mapped {
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
    const n =
      cp.length === 1 && cp.charCodeAt(0) < 0x7f ? foldUnit(cp) : fold(cp.normalize("NFKC"));
    for (const unit of n.split("")) {
      norm += unit;
      from.push(at);
      to.push(r);
    }
  }
  return { norm, from, to };
}

// A rule's evidence and suggestion usually hit the same few paragraphs, so maps are kept.
const cache = new Map<string, Mapped>();
const MAX_CACHED = 256;

function mappedFor(raw: string): Mapped {
  let m = cache.get(raw);
  if (!m) {
    m = normaliseWithMap(raw);
    if (cache.size >= MAX_CACHED) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(raw, m);
  }
  return m;
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
  const { norm, from, to } = mappedFor(paragraph);
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
