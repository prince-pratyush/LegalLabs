import { describe, expect, it } from "vitest";
import { sentences, ungroundedSentences } from "./index.js";

const spans = (text: string) => sentences(text).map(([from, to]) => text.slice(from, to));

describe("sentences", () => {
  it("splits on full stops and line breaks", () => {
    expect(spans("The cap is 12 months. It excludes fraud!\nNext line")).toEqual([
      "The cap is 12 months.",
      "It excludes fraud!",
      "Next line",
    ]);
  });

  it("doesn't split clause numbers or common abbreviations", () => {
    expect(spans("See cl. 12.2 of the MSA, e.g. the cap. Then more.")).toEqual([
      "See cl. 12.2 of the MSA, e.g. the cap.",
      "Then more.",
    ]);
  });
});

describe("ungroundedSentences", () => {
  const text = "The cap is twelve months of fees. It excludes fraud and wilful misconduct.";

  it("flags a claim with no verified citation", () => {
    const cited = [{ at: 33, status: "ok" as const }];
    expect(ungroundedSentences(text, cited).map(([a, b]) => text.slice(a, b))).toEqual([
      "It excludes fraud and wilful misconduct.",
    ]);
  });

  it("treats a flagged citation as no support", () => {
    const cited = [
      { at: 33, status: "ok" as const },
      { at: text.length, status: "mismatch" as const },
    ];
    expect(ungroundedSentences(text, cited)).toHaveLength(1);
  });

  it("counts a citation placed before the full stop", () => {
    expect(ungroundedSentences("The cap is twelve months", [{ at: 24, status: "ok" }])).toEqual([]);
  });

  it("doesn't flag saying something wasn't found, questions or short headings", () => {
    const honest =
      "I couldn't find a termination clause in the selected documents. Do you want me to check the schedules? Summary:";
    expect(ungroundedSentences(honest, [])).toEqual([]);
  });
});
