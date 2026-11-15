/** One cell as the reader wrote it: "B4: =SUM(B1:B3) → 12", with where it sits in the page text. */
export interface SheetCell {
  addr: string;
  col: number;
  row: number;
  /** The formula when there is one, else the value. */
  raw: string;
  value: string;
  formula: string | null;
  from: number;
  to: number;
}

export interface Sheet {
  name: string;
  cells: SheetCell[];
  rows: number;
  cols: number;
}

const CELL = /^([A-Z]{1,3})(\d{1,7}): (.*)$/;
const RESULT = " → ";

export function columnNumber(letters: string): number {
  let n = 0;
  for (const letter of letters) n = n * 26 + (letter.charCodeAt(0) - 64);
  return n;
}

export function columnLetters(n: number): string {
  let out = "";
  for (let rest = n; rest > 0; rest = Math.floor((rest - 1) / 26)) {
    out = String.fromCharCode(65 + ((rest - 1) % 26)) + out;
  }
  return out;
}

/** A sheet page: its name on the first line, then one line per filled cell. */
export function parseSheet(text: string): Sheet {
  const cells: SheetCell[] = [];
  let name = "";
  let offset = 0;
  let rows = 0;
  let cols = 0;
  for (const line of text.split("\n")) {
    const match = CELL.exec(line);
    if (match) {
      const raw = match[3] ?? "";
      const split = raw.startsWith("=") ? raw.lastIndexOf(RESULT) : -1;
      const col = columnNumber(match[1] ?? "A");
      const row = Number(match[2]);
      cells.push({
        addr: `${match[1]}${match[2]}`,
        col,
        row,
        raw,
        formula: split >= 0 ? raw.slice(0, split) : raw.startsWith("=") ? raw : null,
        value: split >= 0 ? raw.slice(split + RESULT.length) : raw,
        from: offset,
        to: offset + line.length,
      });
      rows = Math.max(rows, row);
      cols = Math.max(cols, col);
    } else if (!name && line.trim()) {
      name = line.trim();
    }
    offset += line.length + 1;
  }
  return { name, cells, rows, cols };
}

export interface EmailHeader {
  name: string;
  value: string;
}

export interface Email {
  headers: EmailHeader[];
  /** Where the body starts in the page text, so offsets carry over unchanged. */
  bodyFrom: number;
}

const HEADER = /^(From|To|Cc|Date|Subject): (.*)$/;

/** The reader writes headers as "Name: value" lines, then a blank line, then the body. */
export function parseEmail(text: string): Email {
  const headers: EmailHeader[] = [];
  let offset = 0;
  for (const line of text.split("\n")) {
    const match = HEADER.exec(line);
    if (!match) break;
    headers.push({ name: match[1] ?? "", value: match[2] ?? "" });
    offset += line.length + 1;
  }
  while (text[offset] === "\n") offset++;
  return { headers, bodyFrom: headers.length ? offset : 0 };
}

export interface Segment {
  time: string;
  seconds: number;
  speaker: string;
  from: number;
  to: number;
}

const SEGMENT = /^\[?(\d{1,2}:)?(\d{1,2}):(\d{2})\]? ([^:\n]{1,60}): /;

/** "[01:02:03] Speaker: words" lines. Null unless most lines look like that. */
export function parseTranscript(text: string): Segment[] | null {
  const segments: Segment[] = [];
  let offset = 0;
  let lines = 0;
  for (const line of text.split("\n")) {
    if (line.trim()) lines++;
    const match = SEGMENT.exec(line);
    if (match) {
      const hours = match[1] ? Number(match[1].slice(0, -1)) : 0;
      const seconds = hours * 3600 + Number(match[2]) * 60 + Number(match[3]);
      segments.push({
        time: match[0].slice(0, match[0].indexOf(" ")).replace(/[[\]]/g, ""),
        seconds,
        speaker: match[4] ?? "",
        from: offset + match[0].length,
        to: offset + line.length,
      });
    }
    offset += line.length + 1;
  }
  return lines > 0 && segments.length / lines >= 0.8 ? segments : null;
}
