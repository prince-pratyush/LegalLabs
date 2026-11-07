import { describe, expect, it } from "vitest";
import { colors, type Theme } from "./index.js";

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe("contrast", () => {
  it("matches published WCAG values", () => {
    expect(contrast("#000000", "#FFFFFF")).toBeCloseTo(21, 1);
    expect(contrast("#767676", "#FFFFFF")).toBeCloseTo(4.54, 2);
  });
});

const text = [
  "fg",
  "fgMuted",
  "accent",
  "citation",
  "verified",
  "flagged",
  "locked",
  "destructive",
  "warning",
] as const;
const surfaces = ["bg", "bgSubtle", "bgRaised"] as const;

describe.each(["light", "dark"] as Theme[])("%s theme", (theme) => {
  const c = colors[theme];

  for (const fg of text) {
    for (const bg of surfaces) {
      it(`${fg} on ${bg} is at least 4.5:1`, () => {
        expect(contrast(c[fg], c[bg])).toBeGreaterThanOrEqual(4.5);
      });
    }
  }

  it("external text on its banner is at least 4.5:1", () => {
    expect(contrast(c.externalFg, c.externalBg)).toBeGreaterThanOrEqual(4.5);
  });
});
