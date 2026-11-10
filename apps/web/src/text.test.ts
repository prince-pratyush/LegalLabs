import { describe, expect, it } from "vitest";
import type { Citation } from "./api.js";
import { segments } from "./text.js";

const citation = (n: number, at: number): Citation => ({
  n,
  at,
  document_id: null,
  version_id: null,
  document_name: null,
  page: null,
  quote: null,
  char_from: null,
  char_to: null,
  status: "unresolved",
});

describe("segments", () => {
  it("returns the text alone when nothing is cited", () => {
    expect(segments("Plain answer.", [])).toEqual([{ text: "Plain answer." }]);
  });

  it("places each citation where it was in the text", () => {
    const one = citation(1, 6);
    const two = citation(2, 12);
    expect(segments("Liable. Capped.", [two, one])).toEqual([
      { text: "Liable" },
      { citation: one },
      { text: ". Capp" },
      { citation: two },
      { text: "ed." },
    ]);
  });

  it("keeps citations at the same place in number order", () => {
    const one = citation(1, 3);
    const two = citation(2, 3);
    expect(segments("Yes.", [two, one])).toEqual([
      { text: "Yes" },
      { citation: one },
      { citation: two },
      { text: "." },
    ]);
  });

  it("puts a citation past the end at the end, rather than dropping it", () => {
    const late = citation(1, 99);
    expect(segments("Short", [late])).toEqual([{ text: "Short" }, { citation: late }]);
  });
});
