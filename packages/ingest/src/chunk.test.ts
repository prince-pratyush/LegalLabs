import { describe, expect, it } from "vitest";
import { chunkPages } from "./chunk.js";

const page = (pageNo: number, text: string) => ({ pageNo, text });

describe("chunkPages", () => {
  it("keeps every chunk an exact slice of its page", () => {
    const text = "  First clause.\n\nSecond clause,\nstill second.\n\n\n  Third.  ";
    const chunks = chunkPages([page(1, text)]);
    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) expect(text.slice(c.from, c.to)).toBe(c.text);
  });

  it("joins short paragraphs but never crosses a page", () => {
    const chunks = chunkPages([page(1, "One.\n\nTwo."), page(2, "Three.")]);
    expect(chunks.map((c) => [c.pageNo, c.text])).toEqual([
      [1, "One.\n\nTwo."],
      [2, "Three."],
    ]);
  });

  it("numbers chunks across the whole document", () => {
    const chunks = chunkPages([page(1, "One."), page(2, "Two."), page(3, "Three.")]);
    expect(chunks.map((c) => c.ordinal)).toEqual([0, 1, 2]);
  });

  it("starts a new chunk rather than pass the size limit", () => {
    const para = "a ".repeat(500).trim();
    const chunks = chunkPages([page(1, `${para}\n\n${para}`)]);
    expect(chunks).toHaveLength(2);
  });

  it("splits a long paragraph after a sentence", () => {
    const sentence = `${"word ".repeat(40).trim()}. `;
    const text = sentence.repeat(20).trim();
    const chunks = chunkPages([page(1, text)]);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks.slice(0, -1)) expect(c.text.endsWith(".")).toBe(true);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(1500);
  });

  it("cuts text with no spaces, without losing a character or halving an emoji", () => {
    const text = `a${"😀".repeat(2000)}`;
    const chunks = chunkPages([page(1, text)]);
    expect(chunks.map((c) => c.text).join("")).toBe(text);
    for (const c of chunks) expect(c.text.isWellFormed()).toBe(true);
  });

  it("makes nothing from a blank page", () => {
    expect(chunkPages([page(1, " \n\n \t ")])).toEqual([]);
  });

  it("names the section a chunk sits in, and starts a chunk at each heading", () => {
    const one = "1. Definitions\n\nTerms mean things.\n\n2. Liability\n\nIntro.";
    const two = "2.1 Cap\n\nThe cap is ten.";
    const at = (text: string, title: string) => text.indexOf(title);
    const chunks = chunkPages(
      [page(1, one), page(2, two)],
      [
        { pageNo: 1, from: at(one, "1."), to: at(one, "1.") + 14, level: 1 },
        { pageNo: 1, from: at(one, "2."), to: at(one, "2.") + 12, level: 1 },
        { pageNo: 2, from: 0, to: 7, level: 2 },
      ],
    );
    expect(chunks.map((c) => [c.text, c.section])).toEqual([
      ["1. Definitions\n\nTerms mean things.", "1. Definitions"],
      ["2. Liability\n\nIntro.", "2. Liability"],
      ["2.1 Cap\n\nThe cap is ten.", "2. Liability > 2.1 Cap"],
    ]);
  });

  it("leaves the section empty with no headings", () => {
    expect(chunkPages([page(1, "Body.")])[0]?.section).toBeNull();
  });
});
