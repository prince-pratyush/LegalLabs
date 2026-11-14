import { z } from "zod";
import { chunkPages } from "./chunk.js";
import { cleanText } from "./pdf.js";
import type { Failure, Heading, IngestResult, Page } from "./process.js";

const FAILURES = [
  "UNSUPPORTED_TYPE",
  "FILE_TOO_LARGE",
  "CORRUPT_FILE",
  "ENCRYPTED_NO_PASSWORD",
  "PAGE_LIMIT_EXCEEDED",
  "NO_TEXT",
  "PARSE_TIMEOUT",
  "TOO_COMPLEX",
  "INTERNAL",
] as const satisfies readonly Failure[];

const offset = z.number().int().min(0);
const coord = z.number().finite();

const response = z.union([
  z.object({ ok: z.literal(false), reason: z.enum(FAILURES) }),
  z.object({
    ok: z.literal(true),
    mime: z.string().min(1).max(200),
    pages: z
      .array(
        z.object({
          page_no: z.number().int().min(1),
          width: z.number().min(0).max(1_000_000),
          height: z.number().min(0).max(1_000_000),
          text: z.string(),
          blocks: z.array(
            z.object({ from: offset, to: offset, x0: coord, y0: coord, x1: coord, y1: coord }),
          ),
          headings: z
            .array(
              z.object({
                from: offset,
                to: offset,
                level: z.number().int().min(1).max(9),
                text: z.string(),
              }),
            )
            .default([]),
          ocr: z.boolean().default(false),
        }),
      )
      .min(1),
    children: z
      .array(z.object({ name: z.string().min(1).max(255), content_base64: z.string() }))
      .default([]),
  }),
]);

export interface DocprocOptions {
  url: string;
  fetch?: typeof fetch;
  /** Above the sidecar's own limit, so its answer arrives before ours gives up. */
  timeoutMs?: number;
}

/** Thrown when the sidecar can't be reached, so the caller may fall back or retry. */
export class DocprocUnavailable extends Error {}

const fits = (text: string, span: { from: number; to: number }) =>
  span.from <= span.to && span.to <= text.length;

/** Reads a file through the docproc sidecar. Never trusts its offsets without checking. */
export function createDocprocParser(options: DocprocOptions) {
  const send = options.fetch ?? fetch;
  const endpoint = `${options.url.replace(/\/+$/, "")}/parse`;

  return async (bytes: Uint8Array, name: string): Promise<IngestResult> => {
    const form = new FormData();
    form.set("file", new Blob([bytes]), "upload");
    form.set("name", name);
    let body: unknown;
    try {
      const res = await send(endpoint, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(options.timeoutMs ?? 180_000),
      });
      if (!res.ok) {
        await res.body?.cancel();
        throw new DocprocUnavailable(`docproc answered ${res.status}`);
      }
      body = await res.json();
    } catch (err) {
      if (err instanceof DocprocUnavailable) throw err;
      throw new DocprocUnavailable(err instanceof Error ? err.name : "unknown");
    }

    const parsed = response.safeParse(body);
    if (!parsed.success) return { ok: false, reason: "INTERNAL" };
    const result = parsed.data;
    if (!result.ok) return { ok: false, reason: result.reason };

    const pages: Page[] = [];
    const headings: Heading[] = [];
    for (const page of result.pages) {
      // Offsets index this exact string, so it must arrive already clean.
      if (cleanText(page.text) !== page.text) return { ok: false, reason: "INTERNAL" };
      if (!page.blocks.every((b) => fits(page.text, b))) return { ok: false, reason: "INTERNAL" };
      for (const heading of page.headings) {
        if (!fits(page.text, heading)) return { ok: false, reason: "INTERNAL" };
        headings.push({
          pageNo: page.page_no,
          from: heading.from,
          to: heading.to,
          level: heading.level,
        });
      }
      pages.push({
        pageNo: page.page_no,
        width: page.width,
        height: page.height,
        text: page.text,
        blocks: page.blocks,
      });
    }
    if (pages.some((page, i) => page.pageNo !== i + 1)) return { ok: false, reason: "INTERNAL" };
    const emptyPageCount = pages.filter((page) => page.text.trim() === "").length;
    if (emptyPageCount === pages.length) return { ok: false, reason: "NO_TEXT" };
    return {
      ok: true,
      mime: result.mime,
      pages,
      chunks: chunkPages(pages, headings),
      emptyPageCount,
      ocrPages: result.pages.filter((page) => page.ocr).map((page) => page.page_no),
      children: result.children.map((child) => ({
        name: child.name,
        bytes: new Uint8Array(Buffer.from(child.content_base64, "base64")),
      })),
    };
  };
}
