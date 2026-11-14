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

/** Where a heading starts and ends in its page's text. */
export interface Heading {
  pageNo: number;
  from: number;
  to: number;
  level: number;
}

export interface Child {
  name: string;
  bytes: Uint8Array;
}

export interface Ingested {
  ok: true;
  mime: string;
  pages: Page[];
  chunks: Chunk[];
  emptyPageCount: number;
  /** Pages whose text came from OCR. */
  ocrPages?: number[];
  /** Files found inside this one, such as email attachments, to be read as documents of their own. */
  children?: Child[];
}

export type IngestResult = Ingested | { ok: false; reason: Failure };

export interface Limits {
  maxPages: number;
  maxChars: number;
  maxBlocks: number;
  maxTextBytes: number;
}

// Sized so that one file can't take down a small machine.
export const DEFAULT_LIMITS: Limits = {
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

const starts = (bytes: Uint8Array, magic: readonly number[]) =>
  magic.every((byte, i) => bytes[i] === byte);
const ZIP = [0x50, 0x4b, 0x03, 0x04];
const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const PST = [0x21, 0x42, 0x44, 0x4e];

export const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** Cheap enough to run in the request, so an unreadable type is refused before queueing. */
export function detectType(bytes: Uint8Array, name: string): string | null {
  if (isPdf(bytes)) return "application/pdf";
  // The sidecar checks a container's insides; here the name only picks between kinds.
  if (starts(bytes, ZIP) && /\.docx$/i.test(name)) return DOCX;
  if (starts(bytes, ZIP) && /\.xlsx$/i.test(name)) return XLSX;
  if (starts(bytes, OLE) && /\.msg$/i.test(name)) return "application/vnd.ms-outlook";
  if (starts(bytes, PST)) return "application/vnd.ms-outlook-pst";
  if (/\.eml$/i.test(name)) return "message/rfc822";
  if (/\.txt$/i.test(name)) return "text/plain";
  if (/\.(md|markdown)$/i.test(name)) return "text/markdown";
  return null;
}

/** Types this package reads without the sidecar. */
export const LOCAL_TYPES = new Set(["application/pdf", "text/plain", "text/markdown"]);

/** Runs in the caller's thread: use `ingestFile` for anything a user uploaded. */
export async function processFile(
  bytes: Uint8Array,
  name: string,
  limits: Partial<Limits> = {},
): Promise<IngestResult> {
  const applied = { ...DEFAULT_LIMITS, ...limits };
  const mime = detectType(bytes, name);
  if (mime === null || !LOCAL_TYPES.has(mime)) return { ok: false, reason: "UNSUPPORTED_TYPE" };
  const pages =
    mime === "application/pdf" ? await readPdf(bytes, applied) : readText(bytes, applied);
  if (typeof pages === "string") return { ok: false, reason: pages };
  const emptyPageCount = pages.filter((page) => page.text.trim() === "").length;
  if (emptyPageCount === pages.length) return { ok: false, reason: "NO_TEXT" };
  return { ok: true, mime, pages, chunks: chunkPages(pages), emptyPageCount };
}
