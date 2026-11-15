import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { buildSummaryDocx, buildXlsx, cut } from "./summary.js";

describe("summary files", () => {
  it("cuts text without splitting a surrogate pair", () => {
    expect(cut("ab😀", 3)).toBe("ab");
    expect(cut("ab😀", 4)).toBe("ab😀");
    expect(cut("abc", 2)).toBe("ab");
  });

  it("keeps an over-long cell whole up to Excel's limit, emoji intact", () => {
    const long = `${"a".repeat(32_766)}😀tail`;
    const files = unzipSync(buildXlsx([{ name: "Rules", columns: ["A"], rows: [[long]] }]));
    const xml = strFromU8(files["xl/worksheets/sheet1.xml"] ?? new Uint8Array());
    expect(xml).not.toContain("�");
    expect(xml).toContain(`${"a".repeat(32_766)}</t>`);
  });

  it("gives the summary document the styles it names", () => {
    const files = unzipSync(buildSummaryDocx("Title", ["Intro"], []));
    const styles = strFromU8(files["word/styles.xml"] ?? new Uint8Array());
    expect(styles).toContain('w:styleId="Title"');
    expect(styles).toContain('w:styleId="Heading1"');
    expect(strFromU8(files["word/_rels/document.xml.rels"] ?? new Uint8Array())).toContain(
      'Target="styles.xml"',
    );
    expect(strFromU8(files["[Content_Types].xml"] ?? new Uint8Array())).toContain(
      "/word/styles.xml",
    );
  });
});
