export interface ParsedCitation {
  /** Where the tag stood in the cleaned text. */
  at: number;
  doc: string | null;
  page: number | null;
  quote: string | null;
  /** A public-law citation string, such as "556 U.S. 662"; set only when the tag has one. */
  authority?: string;
  pin?: string;
}

export interface CitedAnswer {
  text: string;
  citations: ParsedCitation[];
}

type Fields = Omit<ParsedCitation, "at">;

const MAX_PAGE = 2 ** 31 - 1;
const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decode(value: string): string {
  return value.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,4});/gi, (entity, body: string) => {
    if (!body.startsWith("#")) return NAMED[body.toLowerCase()] ?? entity;
    const hex = body[1] === "x" || body[1] === "X";
    const code = hex ? Number.parseInt(body.slice(2), 16) : Number(body.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  });
}

function toPage(value: string): number | null {
  if (!/^[1-9][0-9]{0,9}$/.test(value)) return null;
  const page = Number(value);
  return page <= MAX_PAGE ? page : null;
}

/**
 * Splits model output into plain text and the `<c doc page quote/>` tags in it.
 * An authority tag is `<c authority pin quote/>`.
 * Cut-off or garbled tags still leave the text, and stay as citations with
 * whatever could be read, so they show as unresolved instead of vanishing.
 */
export function parseCitedAnswer(raw: string): CitedAnswer {
  const length = raw.length;
  // Searches that found nothing are remembered, so hostile input stays linear.
  const missing = new Set<string>();
  const find = (char: string, from: number) => {
    if (missing.has(char)) return -1;
    const at = raw.indexOf(char, from);
    if (at === -1) missing.add(char);
    return at;
  };

  // Past a garbled attribute: the next `>` outside quotes, or the end.
  const skipToEnd = (from: number): number => {
    let p = from;
    while (p < length) {
      const char = raw[p];
      if (char === ">") return p + 1;
      if (char === '"' || char === "'") {
        const close = find(char, p + 1);
        if (close === -1) {
          // An unmatched quote would otherwise swallow the rest of the answer.
          const end = find(">", p + 1);
          return end === -1 ? length : end + 1;
        }
        p = close + 1;
        continue;
      }
      p++;
    }
    return length;
  };

  const readTag = (from: number): { fields: Fields; end: number } => {
    const fields: Fields = { doc: null, page: null, quote: null };
    const seen = new Set<string>();
    let p = from;
    const skipSpace = () => {
      while (p < length && /\s/.test(raw[p] ?? "")) p++;
    };
    for (;;) {
      skipSpace();
      if (p >= length) return { fields, end: length };
      if (raw[p] === ">") return { fields, end: p + 1 };
      if (raw[p] === "/" && raw[p + 1] === ">") return { fields, end: p + 2 };
      const name = /^[A-Za-z_][\w-]{0,31}/.exec(raw.slice(p, p + 32))?.[0];
      if (!name) return { fields, end: skipToEnd(p) };
      p += name.length;
      skipSpace();
      if (raw[p] !== "=") return { fields, end: skipToEnd(p) };
      p++;
      skipSpace();
      const quote = raw[p];
      if (quote !== '"' && quote !== "'") return { fields, end: skipToEnd(p) };
      const close = find(quote, p + 1);
      if (close === -1) return { fields, end: length };
      const value = decode(raw.slice(p + 1, close));
      p = close + 1;
      if (seen.has(name)) continue;
      seen.add(name);
      if (name === "doc") fields.doc = value;
      else if (name === "page") fields.page = toPage(value);
      else if (name === "quote") fields.quote = value;
      else if (name === "authority") fields.authority = value;
      else if (name === "pin") fields.pin = value;
    }
  };

  let text = "";
  const citations: ParsedCitation[] = [];
  let i = 0;
  while (i < length) {
    const open = raw.indexOf("<", i);
    if (open === -1) {
      text += raw.slice(i);
      break;
    }
    text += raw.slice(i, open);
    const next = raw[open + 1];
    const after = raw[open + 2];
    // A tag cut off by the output limit before it could be read.
    if (next === undefined || (next === "c" && after === undefined)) break;
    if (raw.startsWith("</c>", open)) {
      i = open + 4;
      continue;
    }
    if (next !== "c" || !/[\s/>]/.test(after ?? "")) {
      text += "<";
      i = open + 1;
      continue;
    }
    const { fields, end } = readTag(open + 2);
    citations.push({ at: text.length, ...fields });
    i = end;
  }
  return { text, citations };
}
