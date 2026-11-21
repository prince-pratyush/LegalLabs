export type DiffOp = { op: "equal" | "insert" | "delete"; text: string };

// Words and the spaces between them are separate tokens, so a redline keeps layout.
const tokens = (text: string) => text.match(/\s+|[^\s]+/g) ?? [];

/** Largest edit distance tried; beyond it the whole text is shown as replaced. */
const MAX_EDITS = 4000;

/**
 * Word-level Myers diff (agents-workflows.md §9): the model never writes the diff, so the
 * same two texts always give the same redline. Adjacent ops of one kind are merged.
 */
export function diffWords(before: string, after: string): DiffOp[] {
  const a = tokens(before);
  const b = tokens(after);
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, MAX_EDITS);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = false;
  for (let d = 0; d <= max && !found; d += 1) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      const down = k === -d || (k !== d && (v[offset + k - 1] ?? 0) < (v[offset + k + 1] ?? 0));
      x = down ? (v[offset + k + 1] ?? 0) : (v[offset + k - 1] ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
  }
  if (!found)
    return merge([
      ...(before ? [{ op: "delete" as const, text: before }] : []),
      ...(after ? [{ op: "insert" as const, text: after }] : []),
    ]);

  const ops: DiffOp[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d -= 1) {
    const vd = trace[d] as Int32Array;
    const k = x - y;
    const down = k === -d || (k !== d && (vd[offset + k - 1] ?? 0) < (vd[offset + k + 1] ?? 0));
    const prevK = down ? k + 1 : k - 1;
    const prevX = vd[offset + prevK] ?? 0;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ op: "equal", text: a[x - 1] as string });
      x -= 1;
      y -= 1;
    }
    if (d > 0) {
      if (x === prevX) ops.push({ op: "insert", text: b[y - 1] as string });
      else ops.push({ op: "delete", text: a[x - 1] as string });
    }
    x = prevX;
    y = prevY;
  }
  return merge(ops.reverse());
}

function merge(ops: DiffOp[]): DiffOp[] {
  const out: DiffOp[] = [];
  for (const o of ops) {
    const last = out[out.length - 1];
    if (last && last.op === o.op) last.text += o.text;
    else out.push({ ...o });
  }
  return out;
}

export interface ListChange<T> {
  added: T[];
  removed: T[];
}

/** What a new version adds and drops, compared by key. */
export function diffList<T>(before: T[], after: T[], key: (item: T) => string): ListChange<T> {
  const was = new Map(before.map((i) => [key(i), i]));
  const is = new Map(after.map((i) => [key(i), i]));
  return {
    added: after.filter((i) => !was.has(key(i))),
    removed: before.filter((i) => !is.has(key(i))),
  };
}
