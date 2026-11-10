import { createHash } from "node:crypto";
import {
  type Block,
  type Failure,
  type Ingested,
  type IngestResult,
  ingestFile,
} from "@legallabs/ingest";
import type pg from "pg";
import { type Client, type Principal, uaHash } from "../auth/auth.js";
import { asApp } from "../db.js";

export interface Summary {
  id: string;
  versionId: string;
  name: string;
  mime: string;
  size: number;
  pageCount: number;
  emptyPageCount: number;
  matterId: string | null;
  createdAt: string;
}

export interface UploadInput {
  name: string;
  bytes: Uint8Array;
  matterId: string | null;
}

export type UploadResult =
  | { ok: true; document: Summary }
  | { ok: false; reason: Failure | "FORBIDDEN" | "MATTER_NOT_FOUND" };

export interface Passage {
  chunkId: string;
  documentId: string;
  documentVersionId: string;
  documentName: string;
  page: number;
  /** Where `text` sits in the page text, exactly. */
  from: number;
  to: number;
  text: string;
}

export interface SearchOptions {
  limit?: number;
  documentIds?: readonly string[];
}

export interface Documents {
  upload(principal: Principal, input: UploadInput, client: Client): Promise<UploadResult>;
  /** The caller's newest documents, up to a fixed page. */
  list(principal: Principal): Promise<Summary[]>;
  /** Best match first, limited to what the caller may read. */
  search(principal: Principal, query: string, options?: SearchOptions): Promise<Passage[]>;
  /** Null for anything the caller can't read. Safe to call with ids taken from model output. */
  page(principal: Principal, versionId: string, pageNo: number): Promise<PageContent | null>;
}

export interface PageContent {
  text: string;
  width: number;
  height: number;
  /** Maps verified offsets in `text` to boxes on the page. */
  blocks: Block[];
}

export interface DocumentsOptions {
  ingest?: (bytes: Uint8Array, name: string) => Promise<IngestResult>;
}

const LIST_LIMIT = 100;
const BATCH_SIZE = 200;
const DEFAULT_PASSAGES = 10;
const MAX_PASSAGES = 50;
const MAX_INT = 2 ** 31 - 1;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface SummaryRow {
  id: string;
  version_id: string;
  name: string;
  mime: string;
  size: string;
  page_count: number;
  empty_page_count: number;
  matter_id: string | null;
  created_at: Date;
}

const toSummary = (row: SummaryRow): Summary => ({
  id: row.id,
  versionId: row.version_id,
  name: row.name,
  mime: row.mime,
  size: Number(row.size),
  pageCount: row.page_count,
  emptyPageCount: row.empty_page_count,
  matterId: row.matter_id,
  createdAt: row.created_at.toISOString(),
});

function batches<T>(items: readonly T[]): T[][] {
  const groups: T[][] = [];
  for (let i = 0; i < items.length; i += BATCH_SIZE) groups.push(items.slice(i, i + BATCH_SIZE));
  return groups;
}

export function createDocuments(pool: pg.Pool, options: DocumentsOptions = {}): Documents {
  const ingest = options.ingest ?? ingestFile;

  async function save(
    principal: Principal,
    input: UploadInput,
    parsed: Ingested,
    client: Client,
  ): Promise<Summary> {
    const { userId, workspaceId } = principal;
    return asApp(pool, principal, async (db) => {
      const sha256 = createHash("sha256").update(input.bytes).digest();
      const document = await db.query<
        Omit<SummaryRow, "version_id" | "page_count" | "empty_page_count">
      >(
        `insert into content.document (workspace_id, owner_id, matter_id, name, mime, size)
         values ($1, $2, $3, $4, $5, $6)
         returning id, name, mime, size, matter_id, created_at`,
        [workspaceId, userId, input.matterId, input.name, parsed.mime, input.bytes.length],
      );
      const row = document.rows[0];
      if (!row) throw new Error("insert returned no document");
      const version = await db.query<{ id: string }>(
        `insert into content.document_version
           (workspace_id, document_id, sha256, page_count, empty_page_count, created_by)
         values ($1, $2, $3, $4, $5, $6) returning id`,
        [workspaceId, row.id, sha256, parsed.pages.length, parsed.emptyPageCount, userId],
      );
      const versionId = version.rows[0]?.id;
      if (!versionId) throw new Error("insert returned no version");

      await db.query(
        "insert into content.document_blob (workspace_id, version_id, bytes) values ($1, $2, $3)",
        [workspaceId, versionId, Buffer.from(input.bytes)],
      );
      for (const group of batches(parsed.pages)) {
        await db.query(
          `insert into content.page (workspace_id, version_id, page_no, width, height, text, layout)
           select $1, $2, * from unnest($3::int[], $4::real[], $5::real[], $6::text[], $7::jsonb[])`,
          [
            workspaceId,
            versionId,
            group.map((page) => page.pageNo),
            group.map((page) => page.width),
            group.map((page) => page.height),
            group.map((page) => page.text),
            group.map((page) => JSON.stringify({ blocks: page.blocks })),
          ],
        );
      }
      for (const group of batches(parsed.chunks)) {
        await db.query(
          `insert into content.chunk (workspace_id, version_id, page_no, ordinal, char_from, char_to, text)
           select $1, $2, * from unnest($3::int[], $4::int[], $5::int[], $6::int[], $7::text[])`,
          [
            workspaceId,
            versionId,
            group.map((chunk) => chunk.pageNo),
            group.map((chunk) => chunk.ordinal),
            group.map((chunk) => chunk.from),
            group.map((chunk) => chunk.to),
            group.map((chunk) => chunk.text),
          ],
        );
      }
      // Last in the transaction: an audit failure must undo the upload it describes.
      await db.query(
        "select admin.append_audit_event('document.uploaded', 'user', $1, 'document', $2, $3, $4, $5)",
        [
          userId,
          row.id,
          JSON.stringify({
            version_id: versionId,
            sha256: sha256.toString("hex"),
            size: input.bytes.length,
            page_count: parsed.pages.length,
          }),
          client.ip,
          uaHash(client),
        ],
      );
      return toSummary({
        ...row,
        version_id: versionId,
        page_count: parsed.pages.length,
        empty_page_count: parsed.emptyPageCount,
      });
    });
  }

  return {
    async upload(principal, input, client) {
      // Checked first and closed again, so slow parsing never holds a connection.
      const access = await asApp(pool, principal, async (db) => {
        const { rows } = await db.query<{ allowed: boolean; reachable: boolean }>(
          `select core.has_permission('threads.use') allowed,
                  core.can_access_matter($1::uuid) reachable`,
          [input.matterId],
        );
        return rows[0];
      });
      if (!access?.allowed) return { ok: false, reason: "FORBIDDEN" };
      if (!access.reachable) return { ok: false, reason: "MATTER_NOT_FOUND" };

      const parsed = await ingest(input.bytes, input.name);
      if (!parsed.ok) {
        await asApp(pool, principal, (db) =>
          db.query(
            "select admin.append_audit_event('document.ingest_failed', 'user', $1, null, null, $2, $3, $4)",
            [
              principal.userId,
              JSON.stringify({ failure_reason: parsed.reason, size: input.bytes.length }),
              client.ip,
              uaHash(client),
            ],
          ),
        );
        return { ok: false, reason: parsed.reason };
      }
      return { ok: true, document: await save(principal, input, parsed, client) };
    },

    async search(principal, query, { limit = DEFAULT_PASSAGES, documentIds } = {}) {
      return asApp(pool, principal, async (db) => {
        // The joins matter: text matching can't use an index under row security, so
        // starting from the caller's versions keeps the scan to their own chunks.
        const { rows } = await db.query<{
          id: string;
          version_id: string;
          document_id: string;
          name: string;
          page_no: number;
          char_from: number;
          char_to: number;
          text: string;
        }>(
          `select c.id, c.version_id, v.document_id, d.name, c.page_no, c.char_from, c.char_to, c.text
             from websearch_to_tsquery('english', $1) q,
                  content.document d
             join content.document_version v on v.document_id = d.id
             join content.chunk c on c.version_id = v.id
            where c.tsv @@ q
              and core.has_permission('threads.use')
              and ($3::uuid[] is null or d.id = any($3::uuid[]))
            order by ts_rank_cd(c.tsv, q) desc, c.id
            limit $2`,
          [query, Math.min(limit, MAX_PASSAGES), documentIds ?? null],
        );
        return rows.map((row) => ({
          chunkId: row.id,
          documentId: row.document_id,
          documentVersionId: row.version_id,
          documentName: row.name,
          page: row.page_no,
          from: row.char_from,
          to: row.char_to,
          text: row.text,
        }));
      });
    },

    async page(principal, versionId, pageNo) {
      if (!UUID.test(versionId) || !Number.isInteger(pageNo) || pageNo < 1 || pageNo > MAX_INT) {
        return null;
      }
      return asApp(pool, principal, async (db) => {
        const { rows } = await db.query<{
          text: string;
          width: number;
          height: number;
          layout: { blocks: Block[] };
        }>(
          `select p.text, p.width, p.height, p.layout
             from content.page p
            where p.version_id = $1 and p.page_no = $2 and core.has_permission('threads.use')`,
          [versionId, pageNo],
        );
        const row = rows[0];
        return row
          ? { text: row.text, width: row.width, height: row.height, blocks: row.layout.blocks }
          : null;
      });
    },

    async list(principal) {
      return asApp(pool, principal, async (db) => {
        const { rows } = await db.query<SummaryRow>(
          `select d.id, v.id version_id, d.name, d.mime, d.size, v.page_count,
                  v.empty_page_count, d.matter_id, d.created_at
             from content.document d
             join content.document_version v on v.document_id = d.id
            where core.has_permission('threads.use')
            order by d.id desc
            limit $1`,
          [LIST_LIMIT],
        );
        return rows.map(toSummary);
      });
    },
  };
}
