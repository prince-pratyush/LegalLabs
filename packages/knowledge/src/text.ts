const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  sect: "§",
  ndash: "–",
  mdash: "—",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  hellip: "…",
};

export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/gi, (entity, body: string) => {
    if (!body.startsWith("#")) return NAMED[body.toLowerCase()] ?? entity;
    const hex = body[1] === "x" || body[1] === "X";
    const code = hex ? Number.parseInt(body.slice(2), 16) : Number(body.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  });
}

const BLOCK =
  /<\/?(?:p|div|br|tr|li|h[1-6]|table|section|article|blockquote|pre|dt|dd|ul|ol|hr)\b[^>]*>/gi;

/** Readable text from HTML; scripts, styles and markup go, line breaks stay. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<(script|style|head|noscript)\b[\s\S]*?<\/\1\s*>/gi, "")
      .replace(BLOCK, "\n")
      .replace(/<[^>]*>/g, " "),
  )
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

export const CHUNK_CHARS = 2000;

export interface Chunk {
  sectionPath: string | null;
  text: string;
}

/** Whole paragraphs packed up to a size, so a quote rarely straddles two chunks. */
export function chunkText(text: string, sectionPath: string | null, size = CHUNK_CHARS): Chunk[] {
  const chunks: Chunk[] = [];
  let current = "";
  const flush = () => {
    if (current.trim()) chunks.push({ sectionPath, text: current.trim() });
    current = "";
  };
  for (const paragraph of text.split(/\n+/)) {
    const line = paragraph.trim();
    if (!line) continue;
    if (current && current.length + line.length + 1 > size) flush();
    if (line.length > size) {
      // A paragraph longer than a chunk is cut at word breaks.
      for (let at = 0; at < line.length; ) {
        let end = Math.min(line.length, at + size);
        const space = line.lastIndexOf(" ", end);
        if (end < line.length && space > at) end = space;
        current = line.slice(at, end);
        flush();
        at = end;
      }
      continue;
    }
    current = current ? `${current}\n${line}` : line;
  }
  flush();
  return chunks;
}

/** Splits text at heading lines, so each chunk knows the section it came from. */
export function splitSections(
  text: string,
  heading: RegExp,
  preamble: string,
): { title: string; body: string }[] {
  const sections: { title: string; body: string[] }[] = [{ title: preamble, body: [] }];
  for (const line of text.split("\n")) {
    const match = heading.exec(line.trim());
    if (match) sections.push({ title: (match[1] ?? match[0]).trim(), body: [line] });
    else sections.at(-1)?.body.push(line);
  }
  return sections
    .map((section) => ({ title: section.title, body: section.body.join("\n").trim() }))
    .filter((section) => section.body.length > 0);
}
