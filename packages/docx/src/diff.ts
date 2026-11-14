export type DiffOp = { op: "equal" | "insert" | "delete"; text: string };

// Above this many token pairs the table costs too much memory, so the middle is
// diffed by line instead, and replaced wholesale if that is still too big.
const MAX_CELLS = 4_000_000;

const words = (text: string) => text.match(/\s+|[^\s]+/g) ?? [];
const lines = (text: string) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];

function push(ops: DiffOp[], op: DiffOp["op"], text: string) {
  if (text === "") return;
  const last = ops[ops.length - 1];
  if (last?.op === op) last.text += text;
  else ops.push({ op, text });
}

/** Longest common subsequence over tokens; null when the table would be too big. */
function lcs(a: readonly string[], b: readonly string[]): DiffOp[] | null {
  const n = a.length;
  const m = b.length;
  if (n * m > MAX_CELLS) return null;
  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  const at = (i: number, j: number) => table[i * width + j] ?? 0;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] =
        a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push(ops, "equal", a[i] ?? "");
      i++;
      j++;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      push(ops, "delete", a[i++] ?? "");
    } else {
      push(ops, "insert", b[j++] ?? "");
    }
  }
  while (i < n) push(ops, "delete", a[i++] ?? "");
  while (j < m) push(ops, "insert", b[j++] ?? "");
  return ops;
}

function tokenDiff(a: readonly string[], b: readonly string[]): DiffOp[] {
  // Trimming the shared ends first keeps the table small for typical edits.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (
    end < a.length - start &&
    end < b.length - start &&
    a[a.length - 1 - end] === b[b.length - 1 - end]
  ) {
    end++;
  }
  const ops: DiffOp[] = [];
  push(ops, "equal", a.slice(0, start).join(""));
  const midA = a.slice(start, a.length - end);
  const midB = b.slice(start, b.length - end);
  const middle = lcs(midA, midB) ?? lcs(lines(midA.join("")), lines(midB.join("")));
  if (middle) {
    for (const op of middle) push(ops, op.op, op.text);
  } else {
    push(ops, "delete", midA.join(""));
    push(ops, "insert", midB.join(""));
  }
  push(ops, "equal", a.slice(a.length - end).join(""));
  return ops;
}

/** Word-level diff: equal and delete texts rebuild `before`; equal and insert rebuild `after`. */
export function diffWords(before: string, after: string): DiffOp[] {
  return tokenDiff(words(before), words(after));
}

export type KeyOp = { op: DiffOp["op"]; count: number };

/** Diff over whole items, such as paragraphs, compared by key. */
export function diffKeys(before: readonly string[], after: readonly string[]): KeyOp[] {
  // Each key ends in a character no paragraph holds, so merged runs can be counted back.
  const end = "\u0000";
  const ops = tokenDiff(
    before.map((key) => key.replaceAll(end, "") + end),
    after.map((key) => key.replaceAll(end, "") + end),
  );
  return ops.map((op) => ({ op: op.op, count: op.text.split(end).length - 1 }));
}

export interface ChangeSummary {
  insertions: number;
  deletions: number;
  insertedWords: number;
  deletedWords: number;
}

export function summariseChanges(ops: readonly DiffOp[]): ChangeSummary {
  const count = (text: string) => words(text).filter((word) => word.trim() !== "").length;
  const summary = { insertions: 0, deletions: 0, insertedWords: 0, deletedWords: 0 };
  for (const op of ops) {
    if (op.op === "insert") {
      summary.insertions++;
      summary.insertedWords += count(op.text);
    } else if (op.op === "delete") {
      summary.deletions++;
      summary.deletedWords += count(op.text);
    }
  }
  return summary;
}
