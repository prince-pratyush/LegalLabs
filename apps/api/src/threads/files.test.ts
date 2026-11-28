import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { buildFile, parseFileSpec } from "./files.js";

const sheet = (rows: unknown[][], extra: object = {}) =>
  JSON.stringify({ title: "Fees", sheets: [{ name: "Fees", rows }], ...extra });

const part = (bytes: Uint8Array, name: string) => strFromU8(unzipSync(bytes)[name] as Uint8Array);

describe("the description a model gives of a file", () => {
  it("keeps text that looks like a formula as text", () => {
    const spec = parseFileSpec(
      "xlsx",
      sheet([['=HYPERLINK("https://evil.test","x")', "=cmd|' /C calc'!A0", "@SUM(A1)"]]),
    );
    expect(spec).not.toBeNull();
    const xml = part(buildFile(spec as never, new Date()).bytes, "xl/worksheets/sheet1.xml");
    expect(xml).not.toContain("<f>");
    expect(xml).toContain("=HYPERLINK(");
    expect(xml.match(/t="inlineStr"/g)).toHaveLength(3);
  });

  it("writes only the formulas it knows, over cells of the same sheet", () => {
    const spec = parseFileSpec(
      "xlsx",
      sheet([["Fee"], [10], [32.5], [{ formula: "SUM", range: "A2:A3" }]]),
    );
    const bytes = buildFile(spec as never, new Date()).bytes;
    const xml = part(bytes, "xl/worksheets/sheet1.xml");
    expect(xml).toContain('<c r="A2" s="0"><v>10</v></c>');
    expect(xml).toContain("<f>SUM(A2:A3)</f>");
    expect(part(bytes, "xl/workbook.xml")).toContain('fullCalcOnLoad="1"');
  });

  it.each([
    ["a function off the list", { formula: "HYPERLINK", range: "A1:A1" }],
    ["web access", { formula: "WEBSERVICE", range: "A1" }],
    ["another workbook", { formula: "SUM", range: "[1]Sheet1!A1:A2" }],
    ["another sheet", { formula: "SUM", range: "Other!A1:A2" }],
    ["free text", { formula: "SUM", range: "A1)+cmd|'x'!A0" }],
    ["its own cell", { formula: "SUM", range: "A1:A2" }],
    ["a range past the limits", { formula: "SUM", range: "A2:ZZ999999" }],
    ["a raw formula", "=SUM(A1)" as never],
  ])("refuses %s", (what, cell) => {
    const spec = parseFileSpec("xlsx", sheet([["x"], [cell]]));
    if (what === "a raw formula") return expect(spec).not.toBeNull();
    // The formula sits in A2, so A1:A2 includes itself.
    expect(spec).toBeNull();
  });

  it("refuses anything past its bounds, unknown keys and what isn't JSON", () => {
    const rows = Array.from({ length: 2001 }, () => [1]);
    expect(parseFileSpec("xlsx", sheet(rows))).toBeNull();
    expect(parseFileSpec("xlsx", sheet([Array(31).fill(1)]))).toBeNull();
    expect(parseFileSpec("xlsx", sheet([["x".repeat(4001)]]))).toBeNull();
    expect(parseFileSpec("xlsx", sheet(Array(60).fill(["x".repeat(4000)])))).toBeNull();
    expect(parseFileSpec("xlsx", sheet([[1]], { macro: "x" }))).toBeNull();
    expect(
      parseFileSpec(
        "xlsx",
        JSON.stringify({
          title: "t",
          sheets: [
            { name: "a/b", rows: [] },
            { name: "A B", rows: [] },
          ],
        }),
      ),
    ).toBeNull();
    expect(parseFileSpec("xlsx", "Here is your file.")).toBeNull();
    expect(parseFileSpec("docx", sheet([[1]]))).toBeNull();
    expect(parseFileSpec("docx", "[".repeat(200_000))).toBeNull();
  });

  it("builds a document from headings, paragraphs and lists, fenced or not", () => {
    const spec = parseFileSpec(
      "docx",
      `\`\`\`json\n${JSON.stringify({
        title: "Notice <memo>",
        blocks: [
          { type: "heading", level: 1, text: "Term" },
          { type: "paragraph", text: "One year & a day." },
          { type: "bullet", text: "Renews" },
        ],
      })}\n\`\`\``,
    );
    const file = buildFile(spec as never, new Date("2026-03-02T00:00:00Z"));
    expect(file.name).toBe("Notice memo.docx");
    const xml = part(file.bytes, "word/document.xml");
    expect(xml).toContain("Heading1");
    expect(xml).toContain("One year &amp; a day.");
  });

  it("names the file safely", () => {
    const spec = parseFileSpec(
      "docx",
      JSON.stringify({
        title: '../..‮/etc\u0000: "x"',
        blocks: [{ type: "paragraph", text: "a" }],
      }),
    );
    expect(buildFile(spec as never, new Date()).name).toBe("etc x.docx");
  });
});
