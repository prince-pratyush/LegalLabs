import { strToU8, zipSync } from "fflate";

// The smallest workbook Excel, Numbers and LibreOffice open: inline strings, one fill per style.

export interface XlsxCell {
  text: string;
  /** RGB like "C6EFCE"; header cells are bold instead. */
  fill?: string | undefined;
  bold?: boolean;
}

export interface XlsxSheet {
  name: string;
  rows: XlsxCell[][];
}

const MAX_CELL_CHARS = 32_767;

// Control characters other than tab and newlines are not allowed in XML at all.
const allowedInXml = (ch: string) => {
  const code = ch.codePointAt(0) ?? 0;
  return code >= 0x20
    ? code !== 0xfffe && code !== 0xffff
    : code === 9 || code === 10 || code === 13;
};
const xml = (text: string) =>
  [...text]
    .filter(allowedInXml)
    .join("")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const columnName = (index: number) => {
  let n = index + 1;
  let name = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
};

const sheetName = (name: string) => name.replace(/[[\]:*?/\\]/g, " ").slice(0, 31) || "Sheet";

export function buildXlsx(sheets: readonly XlsxSheet[]): Uint8Array {
  const fills: string[] = [];
  const styleOf = (cell: XlsxCell) => {
    if (cell.bold) return 1;
    if (!cell.fill) return 0;
    let at = fills.indexOf(cell.fill);
    if (at < 0) at = fills.push(cell.fill) - 1;
    return 2 + at;
  };
  const worksheets = sheets.map((sheet) => {
    const rows = sheet.rows
      .map((cells, r) => {
        const body = cells
          .map((cell, c) => {
            const ref = `${columnName(c)}${r + 1}`;
            const text = xml(cell.text.slice(0, MAX_CELL_CHARS));
            return `<c r="${ref}" s="${styleOf(cell)}" t="inlineStr"><is><t xml:space="preserve">${text}</t></is></c>`;
          })
          .join("");
        return `<row r="${r + 1}">${body}</row>`;
      })
      .join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;
  });
  const fillXml = fills
    .map(
      (rgb) =>
        `<fill><patternFill patternType="solid"><fgColor rgb="FF${rgb}"/></patternFill></fill>`,
    )
    .join("");
  const xfs = [
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>',
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" applyFont="1"/>',
    ...fills.map(
      (_, i) =>
        `<xf numFmtId="0" fontId="0" fillId="${i + 2}" borderId="0" applyFill="1" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>`,
    ),
  ];
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="${2 + fills.length}"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>${fillXml}</fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="${xfs.length}">${xfs.join("")}</cellXfs>
</styleSheet>`;
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("\n")}
</Types>`),
    "_rels/.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    "xl/workbook.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets
      .map(
        (s, i) => `<sheet name="${xml(sheetName(s.name))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`,
      )
      .join("")}</sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
      .map(
        (_, i) =>
          `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
      )
      .join(
        "",
      )}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`),
    "xl/styles.xml": strToU8(styles),
  };
  worksheets.forEach((body, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(body);
  });
  return zipSync(files, { level: 6 });
}
