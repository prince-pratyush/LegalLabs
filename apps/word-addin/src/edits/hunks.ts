import { diffWords } from "@legallabs/docx";

/** One change inside `before`: replace characters [from, to) with `insert`. */
export type Hunk = {
  from: number;
  to: number;
  insert: string;
  /** Which match of `before.slice(from, to)` this is, counting from the start; null if ambiguous. */
  occurrence: number | null;
};

const lastWordStart = (text: string, before: number) => {
  const head = text.slice(0, before).replace(/\s+$/, "");
  const match = /\S+$/.exec(head);
  return match ? match.index : null;
};

const nextWordEnd = (text: string, after: number) => {
  const match = /^\s*\S+/.exec(text.slice(after));
  return match ? after + match[0].length : null;
};

/** Non-overlapping, as Word's search counts them. */
function occurrenceAt(text: string, find: string, at: number): number | null {
  if (!find) return null;
  let k = 0;
  for (let i = text.indexOf(find); i !== -1; i = text.indexOf(find, i + find.length), k++) {
    if (i === at) return k;
    if (i > at) return null;
  }
  return null;
}

/**
 * The smallest set of word-level edits that turns `before` into `after`.
 * Every hunk deletes something, because Word can only find text that is there:
 * a pure insertion takes the word before it (or after it) along.
 */
export function hunks(before: string, after: string): Hunk[] {
  const raw: { from: number; to: number; insert: string }[] = [];
  let at = 0;
  for (const op of diffWords(before, after)) {
    if (op.op === "equal") {
      at += op.text.length;
      continue;
    }
    let current = raw.at(-1);
    const gap = current ? before.slice(current.to, at) : "";
    // Edits split only by spaces read as one change, and need one search instead of two.
    if (current && /^\s*$/.test(gap)) {
      current.insert += gap;
      current.to = at;
    } else {
      current = { from: at, to: at, insert: "" };
      raw.push(current);
    }
    if (op.op === "delete") {
      current.to = at + op.text.length;
      at += op.text.length;
    } else current.insert += op.text;
  }

  return raw.map((hunk) => {
    let { from, to, insert } = hunk;
    if (from === to) {
      const start = lastWordStart(before, from);
      if (start !== null) {
        insert = before.slice(start, from) + insert;
        from = start;
      } else {
        const end = nextWordEnd(before, to);
        if (end !== null) {
          insert += before.slice(to, end);
          to = end;
        }
      }
    }
    return { from, to, insert, occurrence: occurrenceAt(before, before.slice(from, to), from) };
  });
}

/** Applies hunks to text, as Word would: a check that hunks rebuild `after`. */
export function applyHunks(before: string, list: readonly Hunk[]): string {
  let out = "";
  let at = 0;
  for (const hunk of list) {
    out += before.slice(at, hunk.from) + hunk.insert;
    at = hunk.to;
  }
  return out + before.slice(at);
}
