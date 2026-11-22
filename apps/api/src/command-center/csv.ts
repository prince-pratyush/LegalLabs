export type Cell = string | number | null | undefined;

// A cell that starts with one of these is run as a formula by spreadsheets, so it gets a quote.
const FORMULA = /^[=+\-@\t\r]/;

export function cell(value: Cell): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  const safe = FORMULA.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export const csvLine = (cells: Cell[]) => `${cells.map(cell).join(",")}\r\n`;

export const toCsv = (header: string[], rows: Cell[][]) =>
  csvLine(header) + rows.map(csvLine).join("");
