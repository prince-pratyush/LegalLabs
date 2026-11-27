import { describe, expect, it } from "vitest";
import { normalizeCitation } from "./authority.js";

const same = (forms: readonly string[]) => [...new Set(forms.map(normalizeCitation))];

describe("Federal Register citations", () => {
  it("reads the ways a volume and page are written as one", () => {
    expect(
      same([
        "85 FR 58029",
        "85 F.R. 58029",
        "85 Fed. Reg. 58029",
        "85 Fed. Reg. 58,029",
        "85 Fed. Reg. 58,029 (Sept. 17, 2020)",
      ]),
    ).toEqual(["85 fr 58029"]);
  });

  it("reads a document number with or without its label's variants", () => {
    expect(same(["FR Doc. 2020-17747", "FR Doc 2020-17747", "FR Doc. No. 2020-17747"])).toEqual([
      "fr doc 2020-17747",
    ]);
  });

  it("leaves other citations as they were", () => {
    expect(normalizeCitation("410 U.S. 113 (1973)")).toBe("410 us 113");
    expect(normalizeCitation("12 F.4th 100")).toBe("12 f4th 100");
  });
});
