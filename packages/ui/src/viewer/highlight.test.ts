import { describe, expect, it } from "vitest";
import { locateQuote, normalise, rectsFor } from "./highlight.js";

const lines = [
  { from: 0, to: 10, x0: 100, y0: 50, x1: 200, y1: 62 },
  { from: 11, to: 21, x0: 100, y0: 64, x1: 200, y1: 76 },
];

describe("rectsFor", () => {
  it("cuts a partly covered line in proportion to its characters", () => {
    expect(rectsFor(lines, 5, 10)).toEqual([{ x: 150, y: 50, width: 50, height: 12 }]);
  });

  it("gives one box per line a span wraps across", () => {
    const rects = rectsFor(lines, 5, 16);
    expect(rects).toHaveLength(2);
    expect(rects[1]).toEqual({ x: 100, y: 64, width: 50, height: 12 });
  });

  it("gives nothing for a span outside every line", () => {
    expect(rectsFor(lines, 30, 40)).toEqual([]);
  });
});

describe("normalise", () => {
  it("folds whitespace, quotes and case, and remembers where each character was", () => {
    const { text, at } = normalise("A  “B”\n c");
    expect(text).toBe('a "b" c');
    expect(at).toEqual([0, 3, 3, 4, 5, 8, 8]);
  });
});

describe("locateQuote", () => {
  const page =
    "9.2 Limitation. Except as set out in 9.4, the aggregate liability\nof either party is capped.";

  it("finds a quote that differs only in spacing and quotes", () => {
    const found = locateQuote(page, "the aggregate   liability of either party");
    expect(found?.exact).toBe(true);
    expect(page.slice(found?.from, found?.to)).toBe("the aggregate liability\nof either party");
  });

  it("finds a close match and marks it approximate", () => {
    const found = locateQuote(page, "the aggregate liabilty of either party");
    expect(found?.exact).toBe(false);
    expect(page.slice(found?.from, found?.to)).toContain("aggregate");
  });

  it("finds nothing for a quote that isn't there", () => {
    expect(locateQuote(page, "indemnify the customer against all claims")).toBeNull();
  });
});
