import { describe, expect, it } from "vitest";
import { normalizeCitation, verifyAuthority } from "./authority.js";

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

describe("Code of Federal Regulations citations", () => {
  it("reads the ways a section is written as one", () => {
    expect(
      same([
        "17 C.F.R. § 240.10b-5",
        "17 C.F.R. §240.10b-5",
        "17 CFR 240.10b-5",
        "17 CFR Section 240.10b-5",
        "17 C.F.R. § 240.10b-5 (2024)",
        "17 C.F.R. § 240.10b-5.",
      ]),
    ).toEqual(["17 cfr § 240.10b-5"]);
  });

  const authority = {
    id: "ecfr:section:17-240.10b-5",
    sections: ["§ 240.10b-5", "(b)", "§ 240.10b-5(b)"],
  };
  const sources = {
    authorityById: async () => null,
    authoritiesByCitation: async (key: string) => (key === "17 cfr § 240.10b-5" ? [authority] : []),
    authorityPassages: async () => ["To make any untrue statement of a material fact."],
  };
  const check = (reference: string, more: { pin?: string; quote?: string } = {}) =>
    verifyAuthority({ kind: "authority", reference, ...more }, sources);

  it("checks a paragraph written into the citation as a pin", async () => {
    expect(await check("17 C.F.R. § 240.10b-5(b)")).toMatchObject({ status: "ok" });
    expect(await check("17 C.F.R. § 240.10b-5(z)")).toMatchObject({
      status: "mismatch",
      reason: "pin_not_found",
    });
    // A pin given beside the citation does not excuse the one inside it.
    expect(await check("17 CFR 240.10b-5(z)", { pin: "(b)" })).toMatchObject({
      reason: "pin_not_found",
    });
    expect(await check("17 CFR 240.99(b)")).toMatchObject({ status: "unresolved" });
  });

  it("tells a quote in the text from one that is not", async () => {
    const cite = "17 C.F.R. § 240.10b-5";
    expect(await check(cite, { quote: "untrue statement of a material fact" })).toMatchObject({
      status: "ok",
    });
    expect(await check(cite, { quote: "a wholly different set of words" })).toMatchObject({
      status: "mismatch",
      reason: "quote_not_found",
    });
  });
});
