import { z } from "zod";
import { chunkPages } from "./chunk.js";
import { cleanText } from "./pdf.js";
import {
  DEFAULT_LIMITS,
  detectType,
  type Failure,
  type Heading,
  type IngestResult,
  type Page,
} from "./process.js";

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

// Pages, text and base64 children together; anything bigger is not an honest answer.
const MAX_ANSWER_BYTES = 128 * 1024 * 1024;
const MAX_CHILD_BYTES = 25 * 1024 * 1024;
const MAX_CHILDREN_BYTES = 100 * 1024 * 1024;
const MAX_CHILDREN = 5000;
const MAX_HEADINGS = 20_000;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Reads at most `cap` bytes, so a runaway answer can't fill memory. */
async function readCapped(res: Response, cap: number): Promise<string | null> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) {
      await reader.cancel();
      return null;
    }
    parts.push(value);
  }
  return Buffer.concat(parts).toString("utf8");
}

/** Thrown when the sidecar's answer can't be trusted, so a PDF can still be read locally. */
export class DocprocInvalid extends Error {}

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

/** Reads a file through the docproc sidecar. Never trusts its answer without checking. */
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
      if (res.status === 413) {
        await res.body?.cancel();
        return { ok: false, reason: "FILE_TOO_LARGE" };
      }
      if (!res.ok) {
        await res.body?.cancel();
        throw new DocprocUnavailable(`docproc answered ${res.status}`);
      }
      const text = await readCapped(res, MAX_ANSWER_BYTES);
      if (text === null) throw new DocprocInvalid("answer too large");
      body = JSON.parse(text);
    } catch (err) {
      if (err instanceof DocprocUnavailable || err instanceof DocprocInvalid) throw err;
      if (err instanceof SyntaxError) throw new DocprocInvalid("answer is not JSON");
      throw new DocprocUnavailable(err instanceof Error ? err.name : "unknown");
    }

    const parsed = response.safeParse(body);
    if (!parsed.success) throw new DocprocInvalid("answer has the wrong shape");
    const result = parsed.data;
    if (!result.ok) return { ok: false, reason: result.reason };

    const limits = DEFAULT_LIMITS;
    if (result.pages.length > limits.maxPages) return { ok: false, reason: "PAGE_LIMIT_EXCEEDED" };
    const chars = result.pages.reduce((sum, page) => sum + page.text.length, 0);
    const blocks = result.pages.reduce((sum, page) => sum + page.blocks.length, 0);
    const headingCount = result.pages.reduce((sum, page) => sum + page.headings.length, 0);
    if (chars > limits.maxChars || blocks > limits.maxBlocks || headingCount > MAX_HEADINGS) {
      return { ok: false, reason: "TOO_COMPLEX" };
    }

    const pages: Page[] = [];
    const headings: Heading[] = [];
    const invalid = (why: string) => new DocprocInvalid(why);
    for (const page of result.pages) {
      // Offsets index this exact string, so it must arrive already clean.
      if (cleanText(page.text) !== page.text) throw invalid("text is not clean");
      if (!page.blocks.every((b) => fits(page.text, b))) throw invalid("block outside text");
      for (const heading of page.headings) {
        if (!fits(page.text, heading)) throw invalid("heading outside text");
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
    if (pages.some((page, i) => page.pageNo !== i + 1)) throw invalid("pages out of order");

    if (result.children.length > MAX_CHILDREN) return { ok: false, reason: "TOO_COMPLEX" };
    let childBytes = 0;
    const children = [];
    for (const child of result.children) {
      if (!BASE64.test(child.content_base64)) throw invalid("child is not base64");
      const bytes = new Uint8Array(Buffer.from(child.content_base64, "base64"));
      childBytes += bytes.length;
      if (bytes.length > MAX_CHILD_BYTES || childBytes > MAX_CHILDREN_BYTES) {
        return { ok: false, reason: "TOO_COMPLEX" };
      }
      children.push({ name: child.name, bytes });
    }

    const emptyPageCount = pages.filter((page) => page.text.trim() === "").length;
    if (emptyPageCount === pages.length) return { ok: false, reason: "NO_TEXT" };
    return {
      ok: true,
      // Our own reading of the bytes, not the sidecar's claim.
      mime: detectType(bytes, name) ?? "application/octet-stream",
      pages,
      chunks: chunkPages(pages, headings),
      emptyPageCount,
      ocrPages: result.pages.filter((page) => page.ocr).map((page) => page.page_no),
      children,
    };
  };
}
