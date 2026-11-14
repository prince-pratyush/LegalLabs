export interface Chunk {
  ordinal: number;
  pageNo: number;
  from: number;
  to: number;
  text: string;
  /** Headings above the chunk, outermost first, such as "12. Liability > 12.2 Cap". */
  section: string | null;
}

interface HeadingAt {
  pageNo: number;
  from: number;
  to: number;
  level: number;
}

const MAX_HEADING = 200;
const before = (a: { pageNo: number; from: number }, b: { pageNo: number; from: number }) =>
  a.pageNo < b.pageNo || (a.pageNo === b.pageNo && a.from <= b.from);

const MAX_CHUNK = 1500;

interface Span {
  from: number;
  to: number;
}

function trimmed(text: string, from: number, to: number): Span | null {
  let start = from;
  let end = to;
  while (start < end && /\s/.test(text.charAt(start))) start++;
  while (end > start && /\s/.test(text.charAt(end - 1))) end--;
  return start < end ? { from: start, to: end } : null;
}

function paragraphs(text: string): Span[] {
  const spans: Span[] = [];
  let from = 0;
  for (const gap of text.matchAll(/\n[^\S\n]*\n\s*/g)) {
    const span = trimmed(text, from, gap.index);
    if (span) spans.push(span);
    from = gap.index + gap[0].length;
  }
  const last = trimmed(text, from, text.length);
  if (last) spans.push(last);
  return spans;
}

// Cutting between sentences keeps a clause whole, so it stays quotable from one chunk.
function cutPoint(text: string, from: number): number {
  const limit = from + MAX_CHUNK;
  const window = text.slice(from, limit);
  const floor = Math.floor(MAX_CHUNK / 2);
  const sentence = [...window.matchAll(/[.;:](?=\s)/g)].at(-1);
  if (sentence && sentence.index >= floor) return from + sentence.index + 1;
  const space = window.lastIndexOf(" ");
  if (space >= floor) return from + space;
  const code = text.charCodeAt(limit - 1);
  return code >= 0xd800 && code <= 0xdbff ? limit - 1 : limit;
}

function splitLong(text: string, span: Span): Span[] {
  const parts: Span[] = [];
  let from = span.from;
  while (span.to - from > MAX_CHUNK) {
    const cut = cutPoint(text, from);
    const part = trimmed(text, from, cut);
    if (part) parts.push(part);
    from = cut;
  }
  const rest = trimmed(text, from, span.to);
  if (rest) parts.push(rest);
  return parts;
}

// A heading always starts a chunk, so each chunk sits under one section.
function pageSpans(text: string, breaks: ReadonlySet<number> = new Set()): Span[] {
  const spans: Span[] = [];
  for (const paragraph of paragraphs(text)) {
    for (const part of splitLong(text, paragraph)) {
      const last = spans.at(-1);
      if (last && part.to - last.from <= MAX_CHUNK && !breaks.has(part.from)) last.to = part.to;
      else spans.push({ ...part });
    }
  }
  return spans;
}

/** Offsets index the page text exactly, which is what a citation is checked against. */
export function chunkPages(
  pages: readonly { pageNo: number; text: string }[],
  headings: readonly HeadingAt[] = [],
): Chunk[] {
  const textOf = new Map(pages.map((page) => [page.pageNo, page.text]));
  const ordered = [...headings].sort((a, b) => a.pageNo - b.pageNo || a.from - b.from);
  const open: { level: number; title: string }[] = [];
  let next = 0;
  const chunks: Chunk[] = [];
  for (const { pageNo, text } of pages) {
    const breaks = new Set(ordered.filter((h) => h.pageNo === pageNo).map((h) => h.from));
    for (const { from, to } of pageSpans(text, breaks)) {
      const here = { pageNo, from };
      for (; next < ordered.length && before(ordered[next] as HeadingAt, here); next++) {
        const heading = ordered[next] as HeadingAt;
        const title = (textOf.get(heading.pageNo) ?? "")
          .slice(heading.from, heading.to)
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, MAX_HEADING);
        while (open.length > 0 && (open.at(-1)?.level ?? 0) >= heading.level) open.pop();
        if (title) open.push({ level: heading.level, title });
      }
      const section = open.length > 0 ? open.map((h) => h.title).join(" > ") : null;
      chunks.push({
        ordinal: chunks.length,
        pageNo,
        from,
        to,
        text: text.slice(from, to),
        section,
      });
    }
  }
  return chunks;
}
