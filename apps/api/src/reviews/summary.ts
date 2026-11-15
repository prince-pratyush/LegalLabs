import { strToU8, zipSync } from "fflate";

// The review summary as tables (playbooks-word.md §4.8), written as minimal OOXML by hand:
// two tables don't justify a spreadsheet or word-processing library.

export interface Sheet {
  name: string;
  columns: readonly string[];
  rows: readonly (readonly string[])[];
}

export const RULE_COLUMNS = [
  "Rule",
  "Status",
  "Clause reference",
  "Evidence quote",
  "Recommended language",
  "Justification",
  "Decision",
  "Decided by",
  "Decided at",
] as const;

export const GAP_COLUMNS = [
  "Kind",
  "Severity",
  "Clause reference",
  "Evidence quote",
  "Reason",
  "Recommended language",
  "Decision",
  "Decided by",
  "Decided at",
] as const;

// biome-ignore lint/suspicious/noControlCharactersInRegex: the characters XML 1.0 forbids.
const INVALID = /[^\u{9}\u{A}\u{D}\u{20}-\u{D7FF}\u{E000}-\u{FFFD}\u{10000}-\u{10FFFF}]/gu;
// Excel refuses a cell longer than this.
const MAX_CELL = 32_767;

const esc = (text: string) =>
  text
    .replace(INVALID, "")
    .slice(0, MAX_CELL)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const DOC_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const CT = "application/vnd.openxmlformats-officedocument";

const column = (n: number) => {
  let s = "";
  for (let i = n + 1; i > 0; i = Math.floor((i - 1) / 26)) {
    s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  }
  return s;
};

function sheetXml(sheet: Sheet): string {
  const rows = [sheet.columns, ...sheet.rows].map((cells, r) => {
    const xml = cells
      .map(
        (v, c) =>
          `<c r="${column(c)}${r + 1}" t="inlineStr"${r === 0 ? ' s="1"' : ""}><is><t xml:space="preserve">${esc(v)}</t></is></c>`,
      )
      .join("");
    return `<row r="${r + 1}">${xml}</row>`;
  });
  return `${HEAD}<worksheet xmlns="${MAIN}"><sheetData>${rows.join("")}</sheetData></worksheet>`;
}

const zip = (files: Record<string, string>) =>
  zipSync(
    Object.fromEntries(
      Object.entries(files).map(([name, xml]) => [
        name,
        [strToU8(xml), { mtime: new Date(2000, 0, 1) }],
      ]),
    ),
    { level: 6 },
  );

/** A workbook with one sheet per table; every cell is inline text. */
export function buildXlsx(sheets: readonly Sheet[]): Uint8Array {
  const files: Record<string, string> = {
    "[Content_Types].xml": `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="${CT}.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="${CT}.spreadsheetml.styles+xml"/>${sheets
      .map(
        (_, i) =>
          `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="${CT}.spreadsheetml.worksheet+xml"/>`,
      )
      .join("")}</Types>`,
    "_rels/.rels": `${HEAD}<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${DOC_REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml": `${HEAD}<workbook xmlns="${MAIN}" xmlns:r="${DOC_REL}"><sheets>${sheets
      .map(
        (s, i) =>
          `<sheet name="${esc(s.name.slice(0, 31))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`,
      )
      .join("")}</sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `${HEAD}<Relationships xmlns="${PKG_REL}">${sheets
      .map(
        (_, i) =>
          `<Relationship Id="rId${i + 1}" Type="${DOC_REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
      )
      .join(
        "",
      )}<Relationship Id="rId${sheets.length + 1}" Type="${DOC_REL}/styles" Target="styles.xml"/></Relationships>`,
    // Style 1 is bold, for the header row.
    "xl/styles.xml": `${HEAD}<styleSheet xmlns="${MAIN}"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>`,
  };
  sheets.forEach((s, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = sheetXml(s);
  });
  return zip(files);
}

const para = (text: string, style?: string, bold = false) =>
  `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ""}${text
    .split("\n")
    .map(
      (line, i) =>
        `<w:r>${bold ? "<w:rPr><w:b/></w:rPr>" : ""}${i > 0 ? "<w:br/>" : ""}<w:t xml:space="preserve">${esc(line)}</w:t></w:r>`,
    )
    .join("")}</w:p>`;

function tableXml(sheet: Sheet): string {
  const row = (cells: readonly string[], header: boolean) =>
    `<w:tr>${cells.map((v) => `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr>${para(v, undefined, header)}</w:tc>`).join("")}</w:tr>`;
  const border = (side: string) =>
    `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="999999"/>`;
  return `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders>${["top", "left", "bottom", "right", "insideH", "insideV"].map(border).join("")}</w:tblBorders></w:tblPr><w:tblGrid>${sheet.columns.map(() => "<w:gridCol/>").join("")}</w:tblGrid>${row(sheet.columns, true)}${sheet.rows.map((r) => row(r, false)).join("")}</w:tbl>`;
}

/** A document with a title, intro lines, then a heading and a table per sheet. */
export function buildSummaryDocx(
  title: string,
  intro: readonly string[],
  sheets: readonly Sheet[],
) {
  const body = [
    para(title, "Title"),
    ...intro.map((line) => para(line)),
    ...sheets.flatMap((s) => [para(s.name, "Heading1"), tableXml(s), para("")]),
  ].join("");
  // Landscape: nine columns don't fit across a portrait page.
  const sect =
    '<w:sectPr><w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/><w:pgMar w:top="1000" w:right="1000" w:bottom="1000" w:left="1000" w:header="500" w:footer="500" w:gutter="0"/></w:sectPr>';
  return zip({
    "[Content_Types].xml": `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="${CT}.wordprocessingml.document.main+xml"/></Types>`,
    "_rels/.rels": `${HEAD}<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${DOC_REL}/officeDocument" Target="word/document.xml"/></Relationships>`,
    "word/document.xml": `${HEAD}<w:document xmlns:w="${W}"><w:body>${body}${sect}</w:body></w:document>`,
  });
}
