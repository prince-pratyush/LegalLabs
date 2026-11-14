import type { DocumentHit, PageLayout, RenderManifest } from "@legallabs/contracts";
import type { ViewerSource } from "../components/document-viewer.js";
import type { PdfLoader } from "./pdf.js";

// Fixtures for stories and tests: made-up text, no real client data.
const DOC = "01933b8a-7c2e-7d4a-9f10-3c5e8b2a1d4f";
const VERSION = "01933b8a-7c2f-7a11-8b22-000000000001";

const LINE_HEIGHT = 14;
const LEFT = 72;
const TOP = 72;

/** A page laid out as a PDF reader would store it: text, plus a box per line. */
export function layoutPage(pageNo: number, paragraphs: readonly string[]): PageLayout {
  let text = "";
  const lines: PageLayout["lines"] = [];
  let y = TOP;
  for (const [p, paragraph] of paragraphs.entries()) {
    if (p > 0) {
      text += "\n\n";
      y += LINE_HEIGHT;
    }
    const words = paragraph.split(" ");
    let line = "";
    const flush = () => {
      if (!line) return;
      if (lines.length && !text.endsWith("\n")) text += "\n";
      const from = text.length;
      text += line;
      lines.push({
        from,
        to: text.length,
        x0: LEFT,
        y0: y,
        x1: LEFT + line.length * 5.6,
        y1: y + 11,
      });
      y += LINE_HEIGHT;
      line = "";
    };
    for (const word of words) {
      if ((line + word).length > 80) flush();
      line = line ? `${line} ${word}` : word;
    }
    flush();
  }
  return { page_no: pageNo, width: 612, height: 792, text, lines, ocr: false };
}

const filler = (n: number) =>
  `Section ${n}. The parties agree to the terms set out in this schedule, which forms part of the agreement and applies from the start date until the agreement ends.`;

export const LIABILITY =
  "The Supplier's aggregate liability under this agreement shall not exceed the fees paid in the twelve months before the claim.";

export function pdfPages(count: number): PageLayout[] {
  return Array.from({ length: count }, (_, i) =>
    layoutPage(
      i + 1,
      i === 13
        ? [filler(i + 1), `9.2 Limitation. ${LIABILITY}`, filler(i + 2)]
        : [filler(i + 1), filler(i + 2)],
    ),
  );
}

export function manifest(
  render: RenderManifest["render"],
  pages: readonly PageLayout[],
  extra: Partial<RenderManifest> = {},
): RenderManifest {
  return {
    document_id: DOC,
    version_id: VERSION,
    name: "Master services agreement.pdf",
    mime: "application/pdf",
    size: 1024,
    status: "indexed",
    render,
    page_count: pages.length,
    pages: pages.map((p) => ({ page_no: p.page_no, width: p.width, height: p.height })),
    file_url: render === "pdf" ? "/fixture.pdf" : null,
    parent_id: null,
    attachments: [],
    ...extra,
  };
}

export function fakeSource(
  m: RenderManifest | Promise<RenderManifest>,
  pages: readonly PageLayout[],
): ViewerSource {
  return {
    manifest: () => Promise.resolve(m),
    pages: async (from, to) => pages.filter((p) => p.page_no >= from && p.page_no <= to),
    search: async (query) => {
      const hits: DocumentHit[] = [];
      const needle = query.toLowerCase();
      for (const page of pages) {
        const at = page.text.toLowerCase().indexOf(needle);
        if (at >= 0) {
          hits.push({
            page: page.page_no,
            char_from: at,
            char_to: at + needle.length,
            snippet: page.text.slice(at, at + 80),
          });
        }
      }
      return hits;
    },
  };
}

/** Paints each line's text where its box is, so stories look like pages without pdf.js. */
export function fakePdf(pages: readonly PageLayout[]): PdfLoader {
  return async () => ({
    async renderPage(pageNo, canvas, scale) {
      const page = pages[pageNo - 1];
      const ctx = canvas.getContext?.("2d");
      if (!page || !ctx) return;
      canvas.width = page.width * scale;
      canvas.height = page.height * scale;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#1a1a1a";
      ctx.font = `${10 * scale}px serif`;
      for (const line of page.lines) {
        ctx.fillText(
          page.text.slice(line.from, line.to),
          line.x0 * scale,
          line.y1 * scale - 2 * scale,
        );
      }
    },
    destroy() {},
  });
}
