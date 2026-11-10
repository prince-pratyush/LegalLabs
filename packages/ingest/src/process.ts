import { type Chunk, chunkPages } from "./chunk.js";
import { cleanText, readPdf } from "./pdf.js";

export interface Block {
  from: number;
  to: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface Page {
  pageNo: number;
  width: number;
  height: number;
  text: string;
  /** Empty for files with no layout, such as plain text. */
  blocks: Block[];
}

export type Failure =
  | "UNSUPPORTED_TYPE"
  | "FILE_TOO_LARGE"
  | "CORRUPT_FILE"
  | "ENCRYPTED_NO_PASSWORD"
  | "PAGE_LIMIT_EXCEEDED"
  | "NO_TEXT"
  | "PARSE_TIMEOUT"
  | "TOO_COMPLEX"
  | "INTERNAL";

export interface Ingested {
  ok: true;
  mime: string;
  pages: Page[];
  chunks: Chunk[];
  emptyPageCount: number;
}

export type IngestResult = Ingested | { ok: false; reason: Failure };

export interface Limits {
  maxPages: number;
  maxChars: number;
  maxBlocks: number;
  maxTextBytes: number;
}

// Sized so that one file can't take down a small machine.
const DEFAULT_LIMITS: Limits = {
  maxPages: 1000,
  maxChars: 5_000_000,
  maxBlocks: 200_000,
  maxTextBytes: 5_000_000,
};

const isPdf = (bytes: Uint8Array) =>
  Buffer.from(bytes.subarray(0, 5)).toString("latin1") === "%PDF-";

function readText(bytes: Uint8Array, limits: Limits): Page[] | Failure {
  if (bytes.length > limits.maxTextBytes) return "FILE_TOO_LARGE";
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return "CORRUPT_FILE";
  }
  if (decoded.includes("\0")) return "CORRUPT_FILE";
  const text = cleanText(decoded.replace(/\r\n?/g, "\n"));
  return [{ pageNo: 1, width: 0, height: 0, text, blocks: [] }];
}

function mimeOf(bytes: Uint8Array, name: string): string | null {
  if (isPdf(bytes)) return "application/pdf";
  if (/\.txt$/i.test(name)) return "text/plain";
  if (/\.(md|markdown)$/i.test(name)) return "text/markdown";
  return null;
}

/** Runs in the caller's thread: use `ingestFile` for anything a user uploaded. */
export async function processFile(
  bytes: Uint8Array,
  name: string,
  limits: Partial<Limits> = {},
): Promise<IngestResult> {
  const applied = { ...DEFAULT_LIMITS, ...limits };
  const mime = mimeOf(bytes, name);
  if (mime === null) return { ok: false, reason: "UNSUPPORTED_TYPE" };
  const pages =
    mime === "application/pdf" ? await readPdf(bytes, applied) : readText(bytes, applied);
  if (typeof pages === "string") return { ok: false, reason: pages };
  const emptyPageCount = pages.filter((page) => page.text.trim() === "").length;
  if (emptyPageCount === pages.length) return { ok: false, reason: "NO_TEXT" };
  return { ok: true, mime, pages, chunks: chunkPages(pages), emptyPageCount };
}
