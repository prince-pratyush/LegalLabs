import { describe, expect, it } from "vitest";
import { type Ingested, type IngestResult, processFile } from "./process.js";
import { makePdf } from "./testing.js";

const text = (content: string) => new TextEncoder().encode(content);

function ingested(result: IngestResult): Ingested {
  if (!result.ok) throw new Error(`expected success, got ${result.reason}`);
  return result;
}

const firstPage = (result: IngestResult) => {
  const page = ingested(result).pages[0];
  if (!page) throw new Error("no pages");
  return page;
};

describe("text files", () => {
  it("makes one page and marks markdown as markdown", async () => {
    const result = ingested(await processFile(text("# Title\n\nBody."), "note.md"));
    expect(result.mime).toBe("text/markdown");
    expect(result.pages.map((p) => [p.pageNo, p.text])).toEqual([[1, "# Title\n\nBody."]]);
    expect(result.chunks.map((c) => c.text)).toEqual(["# Title\n\nBody."]);
  });

  it("uses plain newlines so offsets stay simple", async () => {
    expect(firstPage(await processFile(text("One\r\n\r\nTwo"), "a.txt")).text).toBe("One\n\nTwo");
  });

  it.each([
    ["not valid UTF-8", new Uint8Array([0xc3, 0x28, 0x41]), "CORRUPT_FILE"],
    ["a NUL byte, so not really text", text("abc\0def"), "CORRUPT_FILE"],
    ["nothing but spaces", text("  \n "), "NO_TEXT"],
  ])("refuses %s", async (_, bytes, reason) => {
    expect(await processFile(bytes, "a.txt")).toEqual({ ok: false, reason });
  });

  it("refuses a text file over the limit", async () => {
    const result = await processFile(text("abcdef"), "a.txt", { maxTextBytes: 5 });
    expect(result).toEqual({ ok: false, reason: "FILE_TOO_LARGE" });
  });
});

describe("file types", () => {
  it("goes by the content, not the name", async () => {
    const result = ingested(await processFile(makePdf([["Hello there."]]), "disguised.txt"));
    expect(result.mime).toBe("application/pdf");
  });

  it("refuses anything it can't read", async () => {
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    expect(await processFile(zip, "contract.docx")).toEqual({
      ok: false,
      reason: "UNSUPPORTED_TYPE",
    });
  });
});

describe("pdf files", () => {
  it("reads each page in order, with its size", async () => {
    const result = ingested(await processFile(makePdf([["Page one."], ["Page two."]]), "a.pdf"));
    expect(result.pages.map((p) => [p.pageNo, p.text, p.width, p.height])).toEqual([
      [1, "Page one.", 612, 792],
      [2, "Page two.", 612, 792],
    ]);
  });

  it("keeps lines apart and starts a paragraph at a blank line", async () => {
    const page = firstPage(await processFile(makePdf([["One", "two", "", "three"]]), "a.pdf"));
    expect(page.text).toBe("One\ntwo\n\nthree");
  });

  it("gives each line a box measured from the top left of the page", async () => {
    const page = firstPage(await processFile(makePdf([["Clause one", "Clause two"]]), "a.pdf"));
    expect(page.blocks.map((b) => page.text.slice(b.from, b.to))).toEqual([
      "Clause one",
      "Clause two",
    ]);
    const [first] = page.blocks;
    expect(first?.x0).toBeCloseTo(72, 1);
    expect(first?.y1).toBeCloseTo(72, 1);
    expect(first?.y0).toBeCloseTo(60, 1);
    expect(first?.x1).toBeGreaterThan(72);
  });

  it("keeps every chunk an exact slice of its page", async () => {
    const result = ingested(
      await processFile(makePdf([["First (clause).", "", "Second \\ clause."]]), "a.pdf"),
    );
    for (const chunk of result.chunks) {
      const page = result.pages.find((p) => p.pageNo === chunk.pageNo);
      expect(page?.text.slice(chunk.from, chunk.to)).toBe(chunk.text);
    }
  });

  it("counts pages with no text, so a partial scan isn't silently missed", async () => {
    const result = ingested(await processFile(makePdf([["Some text."], []]), "a.pdf"));
    expect(result.emptyPageCount).toBe(1);
    expect(result.chunks).toHaveLength(1);
  });

  it.each([
    ["a scan with no text at all", makePdf([[], []]), {}, "NO_TEXT"],
    ["too many pages", makePdf([["a"], ["b"]]), { maxPages: 1 }, "PAGE_LIMIT_EXCEEDED"],
    ["too much text", makePdf([["abcdefgh"]]), { maxChars: 5 }, "PAGE_LIMIT_EXCEEDED"],
    ["a password", makePdf([["secret"]], { encrypted: true }), {}, "ENCRYPTED_NO_PASSWORD"],
    ["a damaged file", text("%PDF-1.7 this is not really a pdf"), {}, "CORRUPT_FILE"],
  ])("refuses %s", async (_, bytes, limits, reason) => {
    expect(await processFile(bytes, "a.pdf", limits)).toEqual({ ok: false, reason });
  });
});
