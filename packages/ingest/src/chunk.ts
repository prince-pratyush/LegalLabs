export interface Chunk {
  ordinal: number;
  pageNo: number;
  from: number;
  to: number;
  text: string;
}

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

function pageSpans(text: string): Span[] {
  const spans: Span[] = [];
  for (const paragraph of paragraphs(text)) {
    for (const part of splitLong(text, paragraph)) {
      const last = spans.at(-1);
      if (last && part.to - last.from <= MAX_CHUNK) last.to = part.to;
      else spans.push({ ...part });
    }
  }
  return spans;
}

/** Offsets index the page text exactly, which is what a citation is checked against. */
export function chunkPages(pages: readonly { pageNo: number; text: string }[]): Chunk[] {
  const chunks: Chunk[] = [];
  for (const { pageNo, text } of pages) {
    for (const { from, to } of pageSpans(text)) {
      chunks.push({ ordinal: chunks.length, pageNo, from, to, text: text.slice(from, to) });
    }
  }
  return chunks;
}
