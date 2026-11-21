/** One record of a CSV file, with the line it started on (the header is line 1). */
export interface CsvRecord {
  line: number;
  fields: string[];
  /** Set when the record can't be trusted, such as a quote that never closes. */
  error?: string;
}

/**
 * Reads RFC 4180: comma separated, fields in double quotes may hold commas, line breaks and
 * `""` for a quote; CRLF or LF ends a record. A quote that never closes ends the file with one
 * error record, since nothing after it can be told apart. Blank lines are skipped.
 */
export function parseCsv(input: string): CsvRecord[] {
  const text = input.startsWith("﻿") ? input.slice(1) : input;
  const records: CsvRecord[] = [];
  let fields: string[] = [];
  let field = "";
  let quoted = false;
  let started = false;
  let line = 1;
  let recordLine = 1;

  const endField = () => {
    fields.push(field);
    field = "";
  };
  const endRecord = () => {
    endField();
    const blank = fields.length === 1 && fields[0] === "" && !started;
    if (!blank) records.push({ line: recordLine, fields });
    fields = [];
    started = false;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        if (ch === "\n") line++;
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === "") {
      quoted = true;
      started = true;
      continue;
    }
    if (ch === ",") {
      started = true;
      endField();
    } else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      endRecord();
      line++;
      recordLine = line;
    } else {
      started = true;
      field += ch;
    }
  }
  if (quoted) {
    records.push({ line: recordLine, fields: [], error: "A quoted field is never closed." });
    return records;
  }
  if (started || field !== "" || fields.length > 0) endRecord();
  return records;
}

// A cell that starts with these is read as a formula by spreadsheet programs.
const FORMULA = /^[=+\-@\t\r]/;

/** One CSV cell, quoted when needed and defused against spreadsheet formulas. */
export function csvCell(value: string): string {
  const safe = FORMULA.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export const csvLine = (cells: readonly string[]) => `${cells.map(csvCell).join(",")}\r\n`;
