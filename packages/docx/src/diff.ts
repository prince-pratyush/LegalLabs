export type DiffOp = { op: "equal" | "insert" | "delete"; text: string };

// Above this many item pairs the comparison table costs too much memory.
const MAX_CELLS = 4_000_000;

const words = (text: string) => text.match(/\s+|[^\s]+/g) ?? [];
const lines = (text: string) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];

function push(ops: DiffOp[], op: DiffOp["op"], text: string) {
  if (text === "") return;
  const last = ops[ops.length - 1];
  if (last?.op === op) last.text += text;
  else ops.push({ op, text });
}

type Step = DiffOp["op"];

/** Longest common subsequence as steps; null when the table would be too big. */
function lcs(a: readonly string[], b: readonly string[]): Step[] | null {
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
  const steps: Step[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      steps.push("equal");
      i++;
      j++;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      steps.push("delete");
      i++;
    } else {
      steps.push("insert");
      j++;
    }
  }
  while (i++ < n) steps.push("delete");
  while (j++ < m) steps.push("insert");
  return steps;
}

/** How many items both sides share at the start and at the end. */
function sharedEnds(a: readonly string[], b: readonly string[]) {
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
  return { start, end };
}

function apply(ops: DiffOp[], steps: readonly Step[], a: readonly string[], b: readonly string[]) {
  let i = 0;
  let j = 0;
  for (const step of steps) {
    if (step === "equal") {
      push(ops, step, a[i++] ?? "");
      j++;
    } else if (step === "delete") push(ops, step, a[i++] ?? "");
    else push(ops, step, b[j++] ?? "");
  }
}

/**
 * Word-level diff: equal and delete texts rebuild `before`; equal and insert rebuild `after`.
 * Past the size limit the changed middle is diffed by line, and past that again it is
 * reported as one deletion and one insertion.
 */
export function diffWords(before: string, after: string): DiffOp[] {
  const a = words(before);
  const b = words(after);
  // Trimming the shared ends first keeps the table small for typical edits.
  const { start, end } = sharedEnds(a, b);
  const ops: DiffOp[] = [];
  push(ops, "equal", a.slice(0, start).join(""));
  const midA = a.slice(start, a.length - end);
  const midB = b.slice(start, b.length - end);
  const byWord = lcs(midA, midB);
  if (byWord) apply(ops, byWord, midA, midB);
  else {
    const linesA = lines(midA.join(""));
    const linesB = lines(midB.join(""));
    const byLine = lcs(linesA, linesB);
    if (byLine) apply(ops, byLine, linesA, linesB);
    else {
      push(ops, "delete", midA.join(""));
      push(ops, "insert", midB.join(""));
    }
  }
  push(ops, "equal", a.slice(a.length - end).join(""));
  return ops;
}

export type KeyOp = { op: DiffOp["op"]; count: number };

/**
 * Diff over whole items, such as paragraphs, compared by key. Past the size limit
 * the changed middle is reported as all deleted then all inserted, never split.
 */
export function diffKeys(before: readonly string[], after: readonly string[]): KeyOp[] {
  const { start, end } = sharedEnds(before, after);
  const middleA = before.length - start - end;
  const middleB = after.length - start - end;
  const steps: Step[] = [
    ...Array<Step>(start).fill("equal"),
    ...(lcs(before.slice(start, start + middleA), after.slice(start, start + middleB)) ?? [
      ...Array<Step>(middleA).fill("delete"),
      ...Array<Step>(middleB).fill("insert"),
    ]),
    ...Array<Step>(end).fill("equal"),
  ];
  const ops: KeyOp[] = [];
  for (const step of steps) {
    const last = ops[ops.length - 1];
    if (last?.op === step) last.count++;
    else ops.push({ op: step, count: 1 });
  }
  return ops;
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
