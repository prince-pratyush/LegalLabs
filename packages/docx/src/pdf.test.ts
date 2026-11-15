import { strFromU8, unzlibSync } from "fflate";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { markdownBlocks } from "./markdown.js";
import { buildPdf, DEFAULT_LOOK, listLabel, pageLook } from "./pdf.js";
import { sampleFirmTemplate } from "./sample.js";

const DATE = "2026-11-15T01:02:03Z";

// Text drawn with the built-in fonts is stored as hex strings in deflated page streams.
function drawnText(bytes: Uint8Array): string {
  const raw = strFromU8(bytes, true);
  const out: string[] = [];
  for (const m of raw.matchAll(/\/Filter \/FlateDecode[\s\S]*?stream\r?\n/g)) {
    const start = (m.index ?? 0) + m[0].length;
    const end = raw.indexOf("endstream", start);
    const body = Uint8Array.from(raw.slice(start, end), (c) => c.charCodeAt(0));
    try {
      const ops = strFromU8(unzlibSync(body), true);
      for (const hex of ops.matchAll(/<([0-9A-Fa-f]*)> Tj/g)) {
        out.push(String.fromCharCode(...(hex[1]?.match(/../g) ?? []).map((h) => parseInt(h, 16))));
      }
    } catch {
      // Not a page stream (fonts, metadata).
    }
  }
  return out.join(" ");
}

describe("pageLook", () => {
  it("reads the firm's page, fonts, styles, numbering, header and footer", () => {
    const look = pageLook(sampleFirmTemplate());
    expect(look.width).toBe(612);
    expect(look.height).toBe(792);
    expect(look.margin).toEqual({ top: 90, right: 72, bottom: 90, left: 72 });
    expect(look.family).toBe("serif");
    expect(look.styles.normal).toMatchObject({ size: 11.5, after: 10 });
    expect(look.styles.title).toMatchObject({ size: 18, bold: true, caps: true, align: "center" });
    expect(look.styles.heading1).toMatchObject({ size: 15, bold: true });
    expect(look.numbered).toEqual({ format: "lowerLetter", text: "(%1)" });
    expect(look.header).toEqual({
      text: "Example Partners · Confidential",
      align: "right",
      page: false,
    });
    expect(look.footer).toEqual({ text: "Page", align: "center", page: true });
  });
});

describe("listLabel", () => {
  it("writes labels the way Word numbers them", () => {
    expect(listLabel({ format: "lowerLetter", text: "(%1)" }, 1)).toBe("(a)");
    expect(listLabel({ format: "lowerLetter", text: "(%1)" }, 27)).toBe("(aa)");
    expect(listLabel({ format: "upperRoman", text: "%1." }, 14)).toBe("XIV.");
    expect(listLabel({ format: "decimal", text: "%1." }, 3)).toBe("3.");
    expect(listLabel({ format: "bullet", text: "x" }, 3)).toBe("•");
  });
});

describe("buildPdf", () => {
  const draft = "# Scope\n\nThe supplier must deliver.\n\n1. First duty\n2. Second duty\n\nDone. Ω";

  it("lays the draft out on the firm's page with its header, footer and numbering", async () => {
    const bytes = await buildPdf({
      title: "Supply terms",
      blocks: markdownBlocks(draft),
      author: "Ada",
      date: DATE,
      template: sampleFirmTemplate(),
    });
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBe(1);
    expect(pdf.getPage(0).getSize()).toEqual({ width: 612, height: 792 });
    expect(pdf.getTitle()).toBe("Supply terms");
    const text = drawnText(bytes);
    expect(text).toContain("SUPPLY");
    expect(text).toContain("(a)");
    expect(text).toContain("(b)");
    expect(text).toContain("Example Partners · Confidential".replace("·", "·"));
    expect(text).toContain("Page 1");
    // Outside the built-in fonts' range: shown as a question mark, never a crash.
    expect(text).toContain("?");
  });

  it("uses A4 and plain numbers without a template, and the same bytes each time", async () => {
    const make = () => buildPdf({ blocks: markdownBlocks("1. one"), author: "A", date: DATE });
    const bytes = await make();
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPage(0).getSize().width).toBeCloseTo(DEFAULT_LOOK.width, 0);
    expect(drawnText(bytes)).toContain("1.");
    expect(await make()).toEqual(bytes);
  });

  it("breaks long drafts across pages and numbers each one", async () => {
    const long = Array.from({ length: 120 }, (_, i) => `Paragraph ${i + 1} of the draft.`).join(
      "\n\n",
    );
    const bytes = await buildPdf({
      blocks: markdownBlocks(long),
      author: "A",
      date: DATE,
      template: sampleFirmTemplate(),
    });
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBeGreaterThan(2);
    expect(drawnText(bytes)).toContain(`Page ${pdf.getPageCount()}`);
  });
});
