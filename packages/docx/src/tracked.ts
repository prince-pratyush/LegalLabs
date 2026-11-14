import { type DiffOp, diffKeys, diffWords } from "./diff.js";
import {
  delXml,
  insXml,
  Lists,
  markXml,
  oldPPr,
  pack,
  pPrXml,
  type Revision,
  runXml,
} from "./docx.js";
import { type Block, blockText, markdownBlocks, type TextRun } from "./markdown.js";
import { isoSeconds } from "./xml.js";

export interface TrackedInput {
  /** Markdown of the earlier version. */
  before: string;
  /** Markdown of the later version; the document shows this with changes marked. */
  after: string;
  author: string;
  date: Date | string;
  title?: string;
}

const textRuns = (block: Block): TextRun[] =>
  block.runs.filter((run): run is TextRun => "text" in run);

/** The runs covering [from, to) of a block's text, keeping their formatting. */
function slice(runs: readonly TextRun[], from: number, to: number): TextRun[] {
  const out: TextRun[] = [];
  let at = 0;
  for (const run of runs) {
    const start = Math.max(from, at);
    const end = Math.min(to, at + run.text.length);
    if (start < end) out.push({ ...run, text: run.text.slice(start - at, end - at) });
    at += run.text.length;
  }
  return out;
}

const wordCount = (text: string) => text.split(/\s+/).filter(Boolean).length;

/** At least half the words are shared (Dice), so a word diff reads as an edit. */
function similar(old: Block, now: Block): boolean {
  const a = blockText(old);
  const b = blockText(now);
  const total = wordCount(a) + wordCount(b);
  if (total === 0) return true;
  const shared = diffWords(a, b)
    .filter((op) => op.op === "equal")
    .reduce((sum, op) => sum + wordCount(op.text), 0);
  return (2 * shared) / total >= 0.5;
}

function changedRuns(before: Block, after: Block, ops: readonly DiffOp[], rev: Revision): string {
  const oldRuns = textRuns(before);
  const newRuns = textRuns(after);
  let a = 0;
  let b = 0;
  let xml = "";
  for (const op of ops) {
    const length = op.text.length;
    if (op.op === "equal") {
      xml += slice(newRuns, b, b + length)
        .map((run) => runXml(run))
        .join("");
      a += length;
      b += length;
    } else if (op.op === "delete") {
      xml += delXml(slice(oldRuns, a, a + length), rev);
      a += length;
    } else {
      xml += insXml(slice(newRuns, b, b + length), rev);
      b += length;
    }
  }
  return xml;
}

/**
 * A Word document of `after` in which every difference from `before` is a
 * tracked change, so a reviewer can accept or reject each one in Word.
 * Formatting-only changes are not marked.
 */
export function buildTrackedDocx(input: TrackedInput): Uint8Array {
  const before = markdownBlocks(input.before);
  const after = markdownBlocks(input.after);
  const key = (block: Block) => `${block.kind}|${blockText(block)}`;
  let next = 1;
  const rev: Revision = { id: () => next++, author: input.author, date: isoSeconds(input.date) };
  const lists = new Lists();
  const paragraphs: string[] = [];

  const plain = (block: Block) =>
    `<w:p>${pPrXml(block.kind, lists.numId(block.kind))}${textRuns(block)
      .map((run) => runXml(run))
      .join("")}</w:p>`;
  const removed = (block: Block) =>
    `<w:p>${pPrXml(block.kind, lists.numId(block.kind), { mark: markXml("del", rev) })}${delXml(textRuns(block), rev)}</w:p>`;
  const added = (block: Block) =>
    `<w:p>${pPrXml(block.kind, lists.numId(block.kind), { mark: markXml("ins", rev) })}${insXml(textRuns(block), rev)}</w:p>`;
  const changed = (old: Block, now: Block) => {
    const restyled = old.kind === now.kind ? {} : { changedFrom: oldPPr(old.kind, rev) };
    const ops = diffWords(blockText(old), blockText(now));
    return `<w:p>${pPrXml(now.kind, lists.numId(now.kind), restyled)}${changedRuns(old, now, ops, rev)}</w:p>`;
  };

  let i = 0;
  let j = 0;
  let gone: Block[] = [];
  let fresh: Block[] = [];
  // A replaced paragraph is diffed word by word only against a similar one, in
  // order; pairing unrelated paragraphs would show a confusing word soup.
  const settle = () => {
    let g = 0;
    for (const now of fresh) {
      const match = gone.findIndex((old, k) => k >= g && similar(old, now));
      if (match === -1) {
        paragraphs.push(added(now));
        continue;
      }
      for (; g < match; g++) paragraphs.push(removed(gone[g] as Block));
      paragraphs.push(changed(gone[match] as Block, now));
      g = match + 1;
    }
    for (; g < gone.length; g++) paragraphs.push(removed(gone[g] as Block));
    gone = [];
    fresh = [];
  };
  for (const op of diffKeys(before.map(key), after.map(key))) {
    if (op.op === "equal") {
      settle();
      for (let k = 0; k < op.count; k++) {
        paragraphs.push(plain(after[j] as Block));
        i++;
        j++;
      }
    } else if (op.op === "delete") {
      gone.push(...before.slice(i, i + op.count));
      i += op.count;
    } else {
      fresh.push(...after.slice(j, j + op.count));
      j += op.count;
    }
  }
  settle();

  return pack({
    ...(input.title ? { title: input.title } : {}),
    author: input.author,
    date: input.date,
    paragraphs,
    lists,
    trackRevisions: true,
  });
}
