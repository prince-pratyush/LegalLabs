import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { csvSafe } from "./export.js";
import { buildXlsx } from "./xlsx.js";

describe("buildXlsx", () => {
  it("writes inline strings with one style per fill and a second sheet", () => {
    const bytes = buildXlsx([
      {
        name: "Table",
        rows: [
          [
            { text: "Document", bold: true },
            { text: "Law", bold: true },
          ],
          [{ text: "A & B <Ltd>" }, { text: "New York", fill: "C6EFCE" }],
        ],
      },
      { name: "Citations", rows: [[{ text: "q\u0001uote" }]] },
    ]);
    const files = unzipSync(bytes);
    const sheet = strFromU8(files["xl/worksheets/sheet1.xml"] as Uint8Array);
    expect(sheet).toContain("A &amp; B &lt;Ltd&gt;");
    expect(sheet).toContain('<c r="B2" s="2" t="inlineStr">');
    expect(strFromU8(files["xl/styles.xml"] as Uint8Array)).toContain('rgb="FFC6EFCE"');
    expect(strFromU8(files["xl/worksheets/sheet2.xml"] as Uint8Array)).toContain(">quote<");
    expect(strFromU8(files["xl/workbook.xml"] as Uint8Array)).toContain('name="Citations"');
  });
});

describe("csvSafe", () => {
  it("keeps formulas inert, including ones that start with a minus and a digit", () => {
    expect(csvSafe("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvSafe("@cmd")).toBe("'@cmd");
    expect(csvSafe("-1+cmd|' /C calc'!A0")).toBe("'-1+cmd|' /C calc'!A0");
    expect(csvSafe("-$5.00")).toBe("'-$5.00");
    expect(csvSafe("\tx")).toBe("'\tx");
  });

  it("leaves plain numbers alone", () => {
    expect(csvSafe("-1200.00")).toBe("-1200.00");
    expect(csvSafe("1,500,000.00")).toBe("1,500,000.00");
    expect(csvSafe("USD 1,500.00")).toBe("USD 1,500.00");
  });
});
