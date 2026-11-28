import { describe, expect, it } from "vitest";
import { calculate, parseSheet } from "./cells.js";

// The page text the document service writes for a sheet.
const PAGE =
  "Fees\n\nA1: Item\nB1: Amount \u{1f4b0}\n\nA2: Rent\nB2: 2\n\nB3: 4.5\n\n" +
  "B4: =SUM(B2:B3) → 6.5\nB5: =NOW()\nB6: 0.1\nB7: 0.2\nC2: not 7";

const sheet = parseSheet(PAGE);

describe("cells of a spreadsheet page", () => {
  it("reads each cell with its formula, value and place in the page", () => {
    expect(sheet.name).toBe("Fees");
    const total = sheet.cells.get("B4");
    expect(total).toMatchObject({ addr: "B4", formula: "=SUM(B2:B3)", value: 6.5 });
    expect(PAGE.slice(total?.from, total?.to)).toBe("B4: =SUM(B2:B3) → 6.5");
    expect(sheet.cells.get("B5")).toMatchObject({ formula: "=NOW()", value: null });
    expect(sheet.cells.get("B1")?.value).toBeNull();
    expect(sheet.cells.get("C2")?.value).toBeNull();
  });

  it.each([
    ["sum", "B2:B3", 6.5],
    ["sum", "B6:B7", 0.3],
    ["average", "B2:B3", 3.25],
    ["min", "B2:B4", 2],
    ["max", "B2:B4", 6.5],
    ["count", "B1:B5", 3],
    ["difference", "B3,B2", 2.5],
    ["ratio", "B3,B2", 2.25],
  ] as const)("works out %s over %s", (op, range, value) => {
    expect(calculate(sheet, op, range)).toMatchObject({ ok: true, value });
  });

  it("says which cells it used and which it left out", () => {
    const result = calculate(sheet, "sum", "B1:B5");
    expect(result).toMatchObject({ ok: true, value: 13, leftOut: ["B1", "B5"] });
    if (result.ok) expect(result.inputs.map((c) => c.addr)).toEqual(["B2", "B3", "B4"]);
  });

  it("refuses what it can't do safely", () => {
    for (const [op, range] of [
      ["sum", "A1"],
      ["sum", "Other!B2:B3"],
      ["sum", "B2:B3)+1"],
      ["sum", "A1:XFD1048576"],
      ["difference", "B2:B3"],
      ["difference", "B2,B5"],
      ["ratio", "B2,A9"],
      ["eval", "B2:B3"],
    ] as const) {
      expect(calculate(sheet, op as never, range).ok).toBe(false);
    }
  });

  it("reads a text cell that mimics another cell as the text it is", () => {
    const tricky = parseSheet("S\n\nA1: B1: 999\nA2: =1 → 2 → 3");
    expect(tricky.cells.has("B1")).toBe(false);
    expect(tricky.cells.get("A2")).toMatchObject({ formula: "=1 → 2", value: 3 });
  });
});
