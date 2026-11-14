import type {
  DocumentHit,
  DocumentStatus,
  PageLayout,
  RenderKind,
  RenderManifest,
} from "@legallabs/contracts";
import { MAX_LAYOUT_PAGES, viewerPaths } from "@legallabs/contracts";
import { XLSX } from "@legallabs/ingest";
import { contentKey, type ObjectStore } from "@legallabs/storage";
import type pg from "pg";
import { type Client, type Principal, uaHash } from "../auth/auth.js";
import { asApp } from "../db.js";
import type { Documents } from "./documents.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ATTACHMENTS = 200;
const MAX_HITS = 50;
const SNIPPET = 160;

const RENDER: Record<string, RenderKind> = {
  "application/pdf": "pdf",
  [XLSX]: "sheet",
  "message/rfc822": "email",
  "application/vnd.ms-outlook": "email",
};
// Word has no rendered PDF yet, so it reads as pages of text, like plain text does.
export const renderOf = (mime: string): RenderKind => RENDER[mime] ?? "pages";

export type NotReady = { notReady: DocumentStatus };

export interface FileRange {
  bytes: Uint8Array;
  start: number;
  end: number;
  total: number;
  mime: string;
}

export interface Viewer {
  /** Null for anything the caller can't read. Records that the caller opened it. */
  manifest(
    principal: Principal,
    documentId: string,
    versionId: string,
    client: Client,
  ): Promise<RenderManifest | null>;
  /** Pages `from` to `to`, capped at MAX_LAYOUT_PAGES. */
  pages(
    principal: Principal,
    documentId: string,
    versionId: string,
    from: number,
    to: number,
  ): Promise<PageLayout[] | NotReady | null>;
  /** The original bytes, or one range of them. Null for a range past the end too. */
  file(
    principal: Principal,
    documentId: string,
    versionId: string,
    range: { start: number; end: number | null } | null,
  ): Promise<FileRange | "unsatisfiable" | null>;
  search(
    principal: Principal,
    documentId: string,
    versionId: string,
    query: string,
  ): Promise<DocumentHit[] | null>;
}

interface VersionRow {
  id: string;
  version_id: string;
  workspace_id: string;
  name: string;
  mime: string;
  size: string;
  parent_id: string | null;
  status: DocumentStatus;
  sha256: Buffer;
}

// Row security decides visibility; a walled document simply has no row.
const VERSION_SQL = `
  select d.id, v.id version_id, d.workspace_id, d.name, d.mime, d.size, d.parent_id,
         coalesce(j.status, 'indexed') status, v.sha256
    from content.document d
    join content.document_version v on v.document_id = d.id
    left join content.ingest_job j on j.version_id = v.id
   where d.id = $1 and v.id = $2 and core.has_permission('threads.use')`;

const valid = (documentId: string, versionId: string) =>
  UUID.test(documentId) && UUID.test(versionId);

// Narrows a chunk to the first query word in it, so the hit marks a word, not a paragraph.
function narrow(text: string, query: string): { from: number; to: number } {
  const lower = text.toLowerCase();
  for (const word of query.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (word.length < 2) continue;
    const at = lower.indexOf(word);
    if (at >= 0) return { from: at, to: at + word.length };
  }
  return { from: 0, to: text.length };
}

function snippet(text: string, from: number): string {
  const start = Math.max(0, from - SNIPPET / 2);
  const clipped = text
    .slice(start, start + SNIPPET)
    .replace(/\s+/g, " ")
    .trim();
  return `${start > 0 ? "…" : ""}${clipped}${start + SNIPPET < text.length ? "…" : ""}`;
}

export function createViewer(pool: pg.Pool, store: ObjectStore, documents: Documents): Viewer {
  const version = (db: pg.PoolClient, documentId: string, versionId: string) =>
    db.query<VersionRow>(VERSION_SQL, [documentId, versionId]).then((r) => r.rows[0] ?? null);

  return {
    async manifest(principal, documentId, versionId, client) {
      if (!valid(documentId, versionId)) return null;
      return asApp(pool, principal, async (db) => {
        const row = await version(db, documentId, versionId);
        if (!row) return null;
        const pages = await db.query<{ page_no: number; width: number; height: number }>(
          "select page_no, width, height from content.page where version_id = $1 order by page_no",
          [versionId],
        );
        const attachments = await db.query<{ id: string; version_id: string; name: string }>(
          `select d.id, v.id version_id, d.name
             from content.document d
             join content.document_version v on v.document_id = d.id
            where d.parent_id = $1
            order by d.id limit $2`,
          [documentId, MAX_ATTACHMENTS],
        );
        // Who looked at what, never which page or words.
        await db.query(
          "select admin.append_audit_event('document.previewed', 'user', $1, 'document', $2, $3, $4, $5)",
          [
            principal.userId,
            documentId,
            JSON.stringify({ version_id: versionId }),
            client.ip,
            uaHash(client),
          ],
        );
        const render = renderOf(row.mime);
        const ready = row.status === "indexed";
        return {
          document_id: row.id,
          version_id: row.version_id,
          name: row.name,
          mime: row.mime,
          size: Number(row.size),
          status: row.status,
          render,
          page_count: ready ? pages.rows.length : null,
          pages: pages.rows,
          file_url: render === "pdf" ? viewerPaths.file(row.id, row.version_id) : null,
          parent_id: row.parent_id,
          attachments: attachments.rows.map((a) => ({
            document_id: a.id,
            version_id: a.version_id,
            name: a.name,
          })),
        };
      });
    },

    async pages(principal, documentId, versionId, from, to) {
      if (!valid(documentId, versionId)) return null;
      const last = Math.min(to, from + MAX_LAYOUT_PAGES - 1);
      return asApp(pool, principal, async (db) => {
        const row = await version(db, documentId, versionId);
        if (!row) return null;
        if (row.status !== "indexed") return { notReady: row.status };
        const { rows } = await db.query<{
          page_no: number;
          width: number;
          height: number;
          text: string;
          layout: { blocks?: PageLayout["lines"] };
          ocr: boolean;
        }>(
          `select page_no, width, height, text, layout, ocr from content.page
            where version_id = $1 and page_no between $2 and $3 order by page_no`,
          [versionId, from, last],
        );
        return rows.map((page) => ({
          page_no: page.page_no,
          width: page.width,
          height: page.height,
          text: page.text,
          lines: (page.layout.blocks ?? []).map(({ from, to, x0, y0, x1, y1 }) => ({
            from,
            to,
            x0,
            y0,
            x1,
            y1,
          })),
          ocr: page.ocr,
        }));
      });
    },

    async file(principal, documentId, versionId, range) {
      if (!valid(documentId, versionId)) return null;
      const row = await asApp(pool, principal, (db) => version(db, documentId, versionId));
      if (!row) return null;
      const total = Number(row.size);
      const start = range?.start ?? 0;
      const end = Math.min(range?.end ?? total - 1, total - 1);
      if (start > end) return "unsatisfiable";
      const key = contentKey(row.workspace_id, row.sha256.toString("hex"));
      const bytes = await store.getRange(key, start, end);
      return bytes ? { bytes, start, end, total, mime: row.mime } : null;
    },

    async search(principal, documentId, versionId, query) {
      if (!valid(documentId, versionId)) return null;
      const visible = await asApp(pool, principal, (db) => version(db, documentId, versionId));
      if (!visible) return null;
      const passages = await documents.search(principal, query, {
        documentIds: [documentId],
        versionIds: [versionId],
        limit: MAX_HITS,
        match: "all",
      });
      return passages
        .map((p) => {
          const span = narrow(p.text, query);
          return {
            page: p.page,
            char_from: p.from + span.from,
            char_to: p.from + span.to,
            snippet: snippet(p.text, span.from),
          };
        })
        .sort((a, b) => a.page - b.page || a.char_from - b.char_from);
    },
  };
}
