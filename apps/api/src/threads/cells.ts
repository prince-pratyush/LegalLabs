// Cells read back from a spreadsheet's page text, and the few sums done over them. Formulas in the
// file are shown with the value the spreadsheet last stored; none is ever worked out here.

export interface Cell {
  addr: string;
  column: number;
  row: number;
  formula: string | null;
  /** The number in the cell, or the stored result of its formula; null when it has none. */
  value: number | null;
  /** Where the cell's line sits in the page text. */
  from: number;
  to: number;
}

export interface Sheet {
  name: string;
  cells: Map<string, Cell>;
}

const MAX_CELLS = 100_000;
const LINE = /^([A-Z]{1,3})([1-9][0-9]{0,6}): (.*)$/;
const NUMBER = /^-?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/;

const columnNo = (letters: string) =>
  [...letters].reduce((n, letter) => n * 26 + letter.charCodeAt(0) - 64, 0);

const numberOf = (shown: string) => {
  if (shown.length > 40 || !NUMBER.test(shown)) return null;
  const value = Number(shown);
  return Number.isFinite(value) ? value : null;
};

/** One page is one sheet: its name, then a line per filled cell. */
export function parseSheet(text: string): Sheet {
  const cells = new Map<string, Cell>();
  let from = 0;
  let name = "";
  for (const line of text.split("\n")) {
    if (from === 0) name = line;
    const found = from === 0 ? null : LINE.exec(line);
    if (found && cells.size < MAX_CELLS) {
      const [, letters = "", row = "", shown = ""] = found;
      const addr = `${letters}${row}`;
      const isFormula = shown.startsWith("=");
      const arrow = isFormula ? shown.lastIndexOf(" → ") : -1;
      cells.set(addr, {
        addr,
        column: columnNo(letters),
        row: Number(row),
        formula: isFormula ? (arrow < 0 ? shown : shown.slice(0, arrow)) : null,
        value: isFormula ? (arrow < 0 ? null : numberOf(shown.slice(arrow + 3))) : numberOf(shown),
        from,
        to: from + line.length,
      });
    }
    from += line.length + 1;
  }
  return { name, cells };
}

export const OPERATIONS = ["sum", "average", "min", "max", "count", "difference", "ratio"] as const;
export type Operation = (typeof OPERATIONS)[number];

export const MAX_RANGE_CELLS = 5_000;
const RANGE = /^([A-Z]{1,3})([1-9][0-9]{0,6})(?::([A-Z]{1,3})([1-9][0-9]{0,6}))?$/;
const PAIR = /^([A-Z]{1,3}[1-9][0-9]{0,6}),\s?([A-Z]{1,3}[1-9][0-9]{0,6})$/;

export type Calculation =
  | {
      ok: true;
      value: number;
      /** The cells whose numbers went in, in reading order. */
      inputs: Cell[];
      /** Filled cells of the range that hold no number, so were not counted. */
      leftOut: string[];
    }
  | { ok: false };

// Binary fractions leave tails such as 0.30000000000000004.
const tidy = (value: number) => Number(value.toPrecision(15));

export function calculate(sheet: Sheet, op: Operation, range: string): Calculation {
  const no = { ok: false } as const;
  if (!OPERATIONS.includes(op)) return no;
  if (op === "difference" || op === "ratio") {
    const [, first = "", second = ""] = PAIR.exec(range) ?? [];
    const a = sheet.cells.get(first);
    const b = sheet.cells.get(second);
    if (a?.value == null || b?.value == null) return no;
    if (op === "ratio" && b.value === 0) return no;
    const value = op === "difference" ? a.value - b.value : a.value / b.value;
    return Number.isFinite(value)
      ? { ok: true, value: tidy(value), inputs: [a, b], leftOut: [] }
      : no;
  }
  const found = RANGE.exec(range);
  if (!found) return no;
  const [, c1 = "", r1 = "", c2 = c1, r2 = r1] = found;
  const left = columnNo(c1);
  const right = columnNo(c2);
  const top = Number(r1);
  const bottom = Number(r2);
  if (left > right || top > bottom) return no;
  if ((right - left + 1) * (bottom - top + 1) > MAX_RANGE_CELLS) return no;
  const inside = [...sheet.cells.values()]
    .filter((c) => c.column >= left && c.column <= right && c.row >= top && c.row <= bottom)
    .sort((a, b) => a.row - b.row || a.column - b.column);
  const inputs = inside.filter((c) => c.value !== null);
  if (inputs.length === 0) return no;
  const values = inputs.map((c) => c.value as number);
  const sum = values.reduce((total, v) => total + v, 0);
  const value =
    op === "sum"
      ? sum
      : op === "average"
        ? sum / values.length
        : op === "min"
          ? values.reduce((a, b) => Math.min(a, b))
          : op === "max"
            ? values.reduce((a, b) => Math.max(a, b))
            : values.length;
  if (!Number.isFinite(value)) return no;
  return {
    ok: true,
    value: tidy(value),
    inputs,
    leftOut: inside.filter((c) => c.value === null).map((c) => c.addr),
  };
}
