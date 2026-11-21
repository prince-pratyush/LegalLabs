import { describe, expect, it } from "vitest";
import {
  AcceptCandidate,
  codePoints,
  ImportCommit,
  MEMORY_ERROR_CODES,
  MEMORY_LIMITS,
  MemoryInput,
  memoriesConflict,
  memoryStances,
  normalizeMemoryText,
  PersonaliseInput,
} from "./memory.js";
import { STYLE_LIMITS, StylePatch, StyleShare } from "./writing-style.js";

describe("memory limits", () => {
  it("counts code points, not UTF-16 units", () => {
    expect(codePoints("a😀b")).toBe(3);
    expect("😀".length).toBe(2);
  });

  it("names the four codes the endpoints answer with", () => {
    expect(MEMORY_ERROR_CODES).toEqual([
      "LIMIT_MEMORIES",
      "LIMIT_MEMORY_LENGTH",
      "LIMIT_STYLE_SAMPLE",
      "STYLE_SAMPLE_UNREADABLE",
    ]);
    expect(MEMORY_LIMITS.perUser).toBe(1000);
    expect(STYLE_LIMITS.samplePages).toBe(20);
    expect(STYLE_LIMITS.sampleChars).toBe(50_000);
  });
});

describe("memory input", () => {
  it("trims, and refuses empty text, NUL and unknown fields", () => {
    expect(MemoryInput.parse({ text: "  Use British spelling.  " }).text).toBe(
      "Use British spelling.",
    );
    expect(MemoryInput.safeParse({ text: "   " }).success).toBe(false);
    expect(MemoryInput.safeParse({ text: "a\0" }).success).toBe(false);
    expect(MemoryInput.safeParse({ text: "a", source: "asked" }).success).toBe(false);
    // Length is the endpoint's call, so it can answer LIMIT_MEMORY_LENGTH.
    expect(MemoryInput.safeParse({ text: "x".repeat(1001) }).success).toBe(true);
  });

  it("allows an edited candidate or none", () => {
    expect(AcceptCandidate.parse({}).text).toBeUndefined();
    expect(AcceptCandidate.parse({ text: " ok " }).text).toBe("ok");
  });

  it("bounds import commits and personalise answers", () => {
    expect(ImportCommit.safeParse({ rows: [{ line: 2 }] }).success).toBe(true);
    expect(ImportCommit.safeParse({ rows: [{ line: 0 }] }).success).toBe(false);
    expect(
      ImportCommit.safeParse({
        rows: Array.from({ length: 1001 }, (_, i) => ({ line: i + 2 })),
      }).success,
    ).toBe(false);
    expect(PersonaliseInput.safeParse({ answers: { role: "Partner" } }).success).toBe(true);
    expect(PersonaliseInput.safeParse({ answers: { role: "x".repeat(2001) } }).success).toBe(false);
  });
});

describe("normalising", () => {
  it("ignores case, spacing and closing punctuation", () => {
    expect(normalizeMemoryText("  Use  UK spelling. ")).toBe(normalizeMemoryText("use uk spelling"));
    expect(normalizeMemoryText("Use UK spelling")).not.toBe(normalizeMemoryText("Use US spelling"));
  });
});

describe("conflicts", () => {
  it("finds opposite spelling stances", () => {
    expect(memoryStances("Use UK spelling")).toEqual({ spelling: "uk" });
    expect(memoryStances("Please use US spelling in this reply")).toEqual({ spelling: "us" });
    expect(memoriesConflict("Use UK spelling", "use US spelling")).toBe(true);
    expect(memoriesConflict("Use UK spelling", "Use British spelling")).toBe(false);
    expect(memoriesConflict("Use UK spelling", "Address counsel formally")).toBe(false);
  });

  it("reads other axes and ignores comparisons", () => {
    expect(memoriesConflict("Always use the Oxford comma", "Avoid the Oxford comma")).toBe(true);
    expect(memoriesConflict("Keep answers concise", "Give detailed answers")).toBe(true);
    expect(memoriesConflict("Use bullets", "Avoid bullets, write prose")).toBe(true);
    expect(memoryStances("Compare UK spelling and US spelling")).toEqual({});
  });
});

describe("writing style input", () => {
  it("bounds edits", () => {
    expect(StylePatch.safeParse({ name: "Terse" }).success).toBe(true);
    expect(StylePatch.safeParse({ name: "x".repeat(81) }).success).toBe(false);
    expect(StylePatch.safeParse({ instructions: "x".repeat(5001) }).success).toBe(false);
    expect(StylePatch.safeParse({ derived_instructions: "x".repeat(2001) }).success).toBe(false);
    expect(StylePatch.safeParse({ owner_id: "x" }).success).toBe(false);
    expect(StyleShare.safeParse({ shared: true }).success).toBe(true);
  });
});
