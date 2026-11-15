import { describe, expect, it } from "vitest";
import { locate, paraHash } from "./anchor.js";

const doc = ["Title", "1. Term", "The term is ten (10) years.", "2. Law", "New York law applies."];

describe("locate", () => {
  it("finds the paragraph at its recorded index", async () => {
    const anchor = { paragraph_index: 2, para_hash: await paraHash(doc[2] ?? "") };
    expect(await locate(doc, anchor, "ten (10) years")).toEqual({ kind: "paragraph", index: 2 });
  });

  it("follows the clause when paragraphs were added above it", async () => {
    const anchor = { paragraph_index: 2, para_hash: await paraHash(doc[2] ?? "") };
    const moved = ["Draft", "Note", ...doc];
    expect(await locate(moved, anchor, "ten (10) years")).toEqual({ kind: "paragraph", index: 4 });
  });

  it("ignores spacing differences when hashing", async () => {
    expect(await paraHash("The  term is\tten")).toBe(await paraHash(" The term is ten "));
  });

  it("falls back to a search when the clause was edited", async () => {
    const anchor = { paragraph_index: 2, para_hash: await paraHash(doc[2] ?? "") };
    const edited = doc.map((p, i) => (i === 2 ? "The term is five (5) years." : p));
    expect(await locate(edited, anchor, "ten (10) years")).toEqual({ kind: "search" });
  });
});
