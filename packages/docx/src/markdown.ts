export type TextRun = { text: string; bold?: boolean; italic?: boolean };
/** A footnote reference, numbered from 1 into the document's footnotes. */
export type FootnoteRun = { footnote: number };
export type Run = TextRun | FootnoteRun;

export type BlockKind = "heading1" | "heading2" | "heading3" | "paragraph" | "bullet" | "numbered";
export type Block = { kind: BlockKind; runs: Run[] };

const isText = (run: Run): run is TextRun => "text" in run;

/** The plain text of a block; footnote references count as nothing. */
export const blockText = (block: Block) =>
  block.runs.map((run) => (isText(run) ? run.text : "")).join("");

// Same set as \w, compared by code so a long line does no regex work per mark.
function isWord(text: string, at: number): boolean {
  const code = text.charCodeAt(at);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95
  );
}

/** Positions in ascending order, read with a cursor that only moves forward. */
function closers(positions: number[]) {
  let at = 0;
  return (from: number) => {
    while (at < positions.length && (positions[at] ?? 0) < from) at++;
    return positions[at] ?? -1;
  };
}

/**
 * **bold**, *italic* and _italic_; anything unmatched stays as typed. Closing
 * marks are listed once up front and searched forward only, so a long line of
 * unmatched marks costs linear time rather than a rescan per mark.
 */
export function inlineRuns(text: string): TextRun[] {
  const marks: number[] = [];
  const doubles: number[] = [];
  const stars: number[] = [];
  const unders: number[] = [];
  for (let p = 0; p < text.length; p++) {
    if (text[p] === "*" || text[p] === "_") marks.push(p);
    if (text[p] === "*") {
      stars.push(p);
      if (text[p + 1] === "*") doubles.push(p);
    } else if (text[p] === "_" && !isWord(text, p + 1)) unders.push(p);
  }
  const nextDouble = closers(doubles);
  const nextStar = closers(stars);
  const nextUnder = closers(unders);
  const nextMark = closers(marks);

  const runs: TextRun[] = [];
  // Unformatted text is always one stretch since the last run, so it is sliced once.
  let plainFrom = 0;
  let i = 0;
  const emit = (run: TextRun, end: number) => {
    if (plainFrom < i) runs.push({ text: text.slice(plainFrom, i) });
    runs.push(run);
    plainFrom = end;
  };
  while (i < text.length) {
    const char = text[i];
    if (char === "*" && text[i + 1] === "*") {
      const close = nextDouble(i + 3);
      if (close !== -1) {
        emit({ text: text.slice(i + 2, close), bold: true }, close + 2);
        i = close + 2;
        continue;
      }
    }
    if (char === "*") {
      const close = nextStar(i + 2);
      if (close !== -1) {
        emit({ text: text.slice(i + 1, close), italic: true }, close + 1);
        i = close + 1;
        continue;
      }
    } else if (char === "_" && !isWord(text, i - 1)) {
      const close = nextUnder(i + 2);
      if (close !== -1) {
        emit({ text: text.slice(i + 1, close), italic: true }, close + 1);
        i = close + 1;
        continue;
      }
    }
    const mark = nextMark(i + 1);
    i = mark === -1 ? text.length : mark;
  }
  if (plainFrom < text.length) runs.push({ text: text.slice(plainFrom) });
  return runs;
}

const HEADING = /^(#{1,3})\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;

/** A deliberately small Markdown subset: the shapes drafts are written in. */
export function markdownBlocks(markdown: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) blocks.push({ kind: "paragraph", runs: inlineRuns(paragraph.join(" ")) });
    paragraph = [];
  };
  for (const raw of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    const heading = HEADING.exec(line);
    const bullet = BULLET.exec(line);
    const numbered = NUMBERED.exec(line);
    if (line.trim() === "") flush();
    else if (heading) {
      flush();
      const level = heading[1]?.length ?? 1;
      blocks.push({
        kind: `heading${level}` as BlockKind,
        runs: inlineRuns((heading[2] ?? "").trim()),
      });
    } else if (bullet) {
      flush();
      blocks.push({ kind: "bullet", runs: inlineRuns(bullet[1] ?? "") });
    } else if (numbered) {
      flush();
      blocks.push({ kind: "numbered", runs: inlineRuns(numbered[1] ?? "") });
    } else paragraph.push(line.trim());
  }
  flush();
  return blocks;
}
