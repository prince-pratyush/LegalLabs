import { paraHash } from "@legallabs/contracts";
import { DocxError, readDocx } from "@legallabs/docx";
import type { ExistingEdit, ReviewParagraph } from "@legallabs/review";
import { contentKey, type ObjectStore } from "@legallabs/storage";
import type pg from "pg";

export const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PDF = "application/pdf";

export interface VersionMeta {
  documentId: string;
  versionId: string;
  name: string;
  mime: string;
  workspaceId: string;
  sha256: Buffer;
  pageCount: number;
}

/** What a review reads: the body as numbered paragraphs, whatever the file type. */
export interface Source {
  kind: "docx" | "pdf";
  paragraphs: ReviewParagraph[];
  existingEdits: ExistingEdit[];
  excludedRegions: Record<string, number>;
  chars: number;
  pageCount: number | null;
  /** The original file, kept for redlines; only for .docx. */
  bytes: Uint8Array | null;
}

export type SourceFailure = "NOT_FOUND" | "UNSUPPORTED_TYPE" | "NOT_READY" | "UNREADABLE";

/** The version as the caller sees it, or null when RLS hides it. */
export async function versionMeta(db: pg.PoolClient, versionId: string) {
  const { rows } = await db.query<{
    document_id: string;
    name: string;
    mime: string;
    workspace_id: string;
    sha256: Buffer;
    page_count: number;
  }>(
    `select d.id document_id, d.name, d.mime, d.workspace_id, v.sha256, v.page_count
       from content.document_version v join content.document d on d.id = v.document_id
      where v.id = $1`,
    [versionId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    documentId: row.document_id,
    versionId,
    name: row.name,
    mime: row.mime,
    workspaceId: row.workspace_id,
    sha256: row.sha256,
    pageCount: row.page_count,
  } satisfies VersionMeta;
}

export const kindOf = (mime: string) => (mime === DOCX ? "docx" : mime === PDF ? "pdf" : null);

/** Paragraphs of extracted page text: blank lines split them, else each line stands alone. */
export function pageParagraphs(pages: readonly string[]): string[] {
  const out: string[] = [];
  for (const page of pages) {
    const blocks = page.split(/\n\s*\n/);
    const parts = blocks.length > 1 ? blocks : page.split("\n");
    for (const part of parts) {
      const text = part.replace(/\s*\n\s*/g, " ").trim();
      if (text) out.push(text);
    }
  }
  return out;
}

/**
 * Reads the version for review. A .docx is read from its own file, so paragraph indexes match
 * Word's; a PDF from the pages ingest extracted, which must have finished.
 */
export async function loadSource(
  db: pg.PoolClient,
  store: ObjectStore,
  meta: VersionMeta,
): Promise<Source | SourceFailure> {
  const kind = kindOf(meta.mime);
  if (!kind) return "UNSUPPORTED_TYPE";
  if (kind === "docx") {
    const bytes = await store.get(contentKey(meta.workspaceId, meta.sha256.toString("hex")));
    if (!bytes) return "NOT_FOUND";
    try {
      const read = readDocx(bytes);
      return {
        kind,
        bytes,
        paragraphs: read.paragraphs.map((p) => ({
          index: p.index,
          text: p.text,
          ...(p.section_path ? { section_path: p.section_path } : {}),
          excluded: p.excluded,
          para_hash: p.para_hash,
        })),
        existingEdits: read.existingEdits.map((e) => ({
          paragraph_index: e.paragraph_index,
          kind: e.kind,
          text: e.text,
          author: e.author,
        })),
        excludedRegions: Object.fromEntries(
          Object.entries(read.excludedRegions).filter(([, n]) => n > 0),
        ),
        chars: read.charCount,
        pageCount: null,
      };
    } catch (err) {
      if (err instanceof DocxError) return "UNREADABLE";
      throw err;
    }
  }
  const { rows } = await db.query<{ text: string }>(
    "select text from content.page where version_id = $1 order by page_no",
    [meta.versionId],
  );
  if (rows.length === 0) return "NOT_READY";
  const texts = pageParagraphs(rows.map((r) => r.text));
  const paragraphs = await Promise.all(
    texts.map(async (text, index) => ({
      index,
      text,
      excluded: false,
      para_hash: await paraHash(text),
    })),
  );
  return {
    kind,
    bytes: null,
    paragraphs,
    existingEdits: [],
    excludedRegions: {},
    chars: texts.reduce((n, t) => n + t.length + 1, 0),
    pageCount: meta.pageCount,
  };
}
