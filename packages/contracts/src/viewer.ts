import { z } from "zod";
import { Id } from "./id.js";

const MAX_INT = 2 ** 31 - 1;
const Count = z.int().min(0).max(MAX_INT);
const PageNo = z.int().min(1).max(MAX_INT);

export const CitationStatus = z.enum(["ok", "mismatch", "unresolved"]);
export type CitationStatus = z.infer<typeof CitationStatus>;

/** Where a citation points. Pinned to a version so a newer upload never moves it. */
export const Anchor = z
  .object({
    document_id: Id,
    version_id: Id,
    page: PageNo,
    char_from: Count.nullable().optional(),
    char_to: Count.nullable().optional(),
    quote: z.string().max(4000).nullable().optional(),
    status: CitationStatus.optional(),
  })
  .refine((a) => (a.char_from == null) === (a.char_to == null), "give both ends of the span")
  .refine((a) => a.char_from == null || a.char_to == null || a.char_to > a.char_from, {
    message: "the span must not be empty",
  });
export type Anchor = z.infer<typeof Anchor>;

export interface OpenCitationOptions {
  /** Every citation the user can step through with j and k, in order. */
  context?: readonly Anchor[];
  /** A modifier click opens a new tab instead of the viewer here. */
  newTab?: boolean;
}

/** What a citation popover calls to show its source. */
export type OpenCitation = (anchor: Anchor, options?: OpenCitationOptions) => void;

const DOCUMENTS = "/documents/";
const SPAN = /^(\d{1,10})-(\d{1,10})$/;

/**
 * The deep link for an anchor. It holds the location only, never the quote,
 * so text from a document doesn't end up in history or server logs.
 */
export function citationHref(anchor: Anchor): string {
  const params = new URLSearchParams({ v: anchor.version_id, page: String(anchor.page) });
  if (anchor.char_from != null && anchor.char_to != null) {
    params.set("span", `${anchor.char_from}-${anchor.char_to}`);
  }
  return `${DOCUMENTS}${anchor.document_id}?${params}`;
}

export interface DocumentLocation {
  document_id: string;
  version_id: string | null;
  page: number | null;
  span: { from: number; to: number } | null;
}

/** Null for anything that isn't a document link. Bad parameters are dropped, not trusted. */
export function parseDocumentHref(href: string): DocumentLocation | null {
  let url: URL;
  try {
    url = new URL(href, "http://local");
  } catch {
    return null;
  }
  if (!url.pathname.startsWith(DOCUMENTS)) return null;
  const id = Id.safeParse(url.pathname.slice(DOCUMENTS.length));
  if (!id.success) return null;
  const version = Id.safeParse(url.searchParams.get("v"));
  const page = PageNo.safeParse(Number(url.searchParams.get("page") ?? Number.NaN));
  const match = SPAN.exec(url.searchParams.get("span") ?? "");
  const from = Number(match?.[1]);
  const to = Number(match?.[2]);
  const span = match && to > from && to <= MAX_INT ? { from, to } : null;
  return {
    document_id: id.data,
    version_id: version.success ? version.data : null,
    page: page.success ? page.data : null,
    span,
  };
}

/** How the viewer paints a version. Anything without a page layout reads as pages of text. */
export const RenderKind = z.enum(["pdf", "pages", "sheet", "email"]);
export type RenderKind = z.infer<typeof RenderKind>;

export const DocumentStatus = z.enum(["queued", "parsing", "indexed", "failed"]);
export type DocumentStatus = z.infer<typeof DocumentStatus>;

export const PageSize = z.object({ page_no: PageNo, width: z.number(), height: z.number() });
export type PageSize = z.infer<typeof PageSize>;

export const RenderManifest = z.object({
  document_id: Id,
  version_id: Id,
  name: z.string(),
  mime: z.string(),
  size: Count,
  status: DocumentStatus,
  render: RenderKind,
  page_count: Count.nullable(),
  pages: z.array(PageSize),
  /** The original file, for kinds painted from it. Same origin, checked on every request. */
  file_url: z.string().nullable(),
  parent_id: Id.nullable(),
  attachments: z.array(z.object({ document_id: Id, version_id: Id, name: z.string() })),
});
export type RenderManifest = z.infer<typeof RenderManifest>;

/** A line's box in PDF points, origin top-left, and where its text sits in the page text. */
export const PageLine = z.object({
  from: Count,
  to: Count,
  x0: z.number(),
  y0: z.number(),
  x1: z.number(),
  y1: z.number(),
});
export type PageLine = z.infer<typeof PageLine>;

export const PageLayout = z.object({
  page_no: PageNo,
  width: z.number(),
  height: z.number(),
  /** The exact text that citation offsets index into. */
  text: z.string(),
  lines: z.array(PageLine),
  ocr: z.boolean(),
});
export type PageLayout = z.infer<typeof PageLayout>;

export const MAX_LAYOUT_PAGES = 20;

export const DocumentHit = z.object({
  page: PageNo,
  char_from: Count,
  char_to: Count,
  snippet: z.string(),
});
export type DocumentHit = z.infer<typeof DocumentHit>;

const versionPath = (documentId: string, versionId: string) =>
  `/api/v1/documents/${encodeURIComponent(documentId)}/versions/${encodeURIComponent(versionId)}`;

/** The viewer's API in one place, so client and server can't drift. */
export const viewerPaths = {
  manifest: (documentId: string, versionId: string) =>
    `${versionPath(documentId, versionId)}/manifest`,
  pages: (documentId: string, versionId: string, from: number, to: number) =>
    `${versionPath(documentId, versionId)}/pages?from=${from}&to=${to}`,
  file: (documentId: string, versionId: string) => `${versionPath(documentId, versionId)}/file`,
  search: (documentId: string, versionId: string, query: string) =>
    `${versionPath(documentId, versionId)}/search?q=${encodeURIComponent(query)}`,
};
