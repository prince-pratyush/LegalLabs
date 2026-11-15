import { describe, expect, it } from "vitest";
import { CODE_MS, createCodeStore } from "./codes.js";

describe("code store", () => {
  it("swaps a code for its token exactly once", () => {
    const codes = createCodeStore(() => 0);
    const code = codes.issue("token-1");
    expect(code).not.toContain("token-1");
    expect(codes.redeem(code)).toBe("token-1");
    expect(codes.redeem(code)).toBeNull();
  });

  it("refuses a code after a minute", () => {
    let now = 0;
    const codes = createCodeStore(() => now);
    const code = codes.issue("token-1");
    now = CODE_MS;
    expect(codes.redeem(code)).toBeNull();
  });

  it("refuses a code it never issued", () => {
    expect(createCodeStore().redeem("made-up-code-of-a-plausible-length")).toBeNull();
  });
});
