/** RFC 4180: commas, CRLF or LF line ends, double quotes with "" escapes. */
export class CsvError extends Error {}

export interface CsvTable {
  header: string[];
  /** Each record with the 1-based line it started on, the header being line 1. */
  records: { line: number; values: string[] }[];
}

export function parseCsv(input: string, maxRecords: number): CsvTable {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: { line: number; values: string[] }[] = [];
  let field = "";
  let record: string[] = [];
  let quoted = false;
  let line = 1;
  let start = 1;
  let i = 0;
  const endRecord = () => {
    record.push(field);
    field = "";
    // A blank line is not a record.
    if (!(record.length === 1 && record[0] === "")) rows.push({ line: start, values: record });
    if (rows.length > maxRecords + 1) throw new CsvError("TOO_MANY_ROWS");
    record = [];
  };
  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else {
        if (ch === "\n") line++;
        field += ch;
      }
      i++;
      continue;
    }
    if (ch === '"') {
      if (field !== "") throw new CsvError(`A quote must start the field on line ${line}.`);
      quoted = true;
    } else if (ch === ",") {
      record.push(field);
      field = "";
    } else if (ch === "\r" && text[i + 1] === "\n") {
      endRecord();
      line++;
      start = line;
      i++;
    } else if (ch === "\n") {
      endRecord();
      line++;
      start = line;
    } else {
      field += ch;
    }
    i++;
  }
  if (quoted) throw new CsvError(`A quoted field on line ${start} is never closed.`);
  if (field !== "" || record.length > 0) endRecord();
  const [head, ...records] = rows;
  if (!head) throw new CsvError("The file is empty.");
  return { header: head.values.map((h) => h.trim().toLowerCase()), records };
}

// A leading = + - @ makes spreadsheets run the cell as a formula, so it is quoted away.
const FORMULA = /^[=+\-@\t\r]/;

export function toCsv(rows: string[][]): string {
  return rows
    .map((row) =>
      row
        .map((value) => {
          const safe = FORMULA.test(value) ? `'${value}` : value;
          return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
        })
        .join(","),
    )
    .join("\r\n")
    .concat("\r\n");
}
