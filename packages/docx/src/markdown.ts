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

/** **bold**, *italic* and _italic_; anything unmatched stays as typed. */
export function inlineRuns(text: string): TextRun[] {
  const runs: TextRun[] = [];
  const pattern = /\*\*(.+?)\*\*|\*(.+?)\*|(?<![\w])_(.+?)_(?![\w])/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const at = match.index ?? 0;
    if (at > last) runs.push({ text: text.slice(last, at) });
    if (match[1] !== undefined) runs.push({ text: match[1], bold: true });
    else runs.push({ text: match[2] ?? match[3] ?? "", italic: true });
    last = at + match[0].length;
  }
  if (last < text.length) runs.push({ text: text.slice(last) });
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
