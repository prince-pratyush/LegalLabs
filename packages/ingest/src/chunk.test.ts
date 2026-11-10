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
});
