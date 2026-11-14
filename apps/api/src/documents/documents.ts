import { createHash } from "node:crypto";
import { type Block, detectType, type Failure } from "@legallabs/ingest";
import { contentKey, type ObjectStore } from "@legallabs/storage";
import type pg from "pg";
import { type Client, type Principal, uaHash } from "../auth/auth.js";
import { asApp } from "../db.js";

export type Status = "queued" | "parsing" | "indexed" | "failed";

export interface Summary {
  id: string;
  versionId: string;
  name: string;
  mime: string;
  size: number;
  status: Status;
  /** Set only when `status` is "failed". */
  failureReason: string | null;
  /** Null until the file is indexed. */
  pageCount: number | null;
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
  | {
      ok: false;
      reason:
        | Extract<Failure, "UNSUPPORTED_TYPE" | "FILE_TOO_LARGE">
        | "FORBIDDEN"
        | "MATTER_NOT_FOUND";
    };

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
  /** Pins a search to exact versions, as a thread that cites them needs. */
  versionIds?: readonly string[];
  /** "any" finds passages with some of the words, as a typed question needs. */
  match?: "all" | "any";
}

export interface Documents {
  /** Stores the file and queues it; reading it happens in the ingest worker. */
  upload(principal: Principal, input: UploadInput, client: Client): Promise<UploadResult>;
  /** The caller's newest documents, up to a fixed page. */
  list(principal: Principal): Promise<Summary[]>;
  /** Null for anything the caller can't read. */
  get(principal: Principal, documentId: string): Promise<Summary | null>;
  /** Queues a failed file again. False if it isn't the caller's failed file. */
  retry(principal: Principal, documentId: string): Promise<boolean>;
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
  store: ObjectStore;
}

const LIST_LIMIT = 100;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
const DEFAULT_PASSAGES = 10;
export const MAX_PASSAGES = 50;
const MAX_INT = 2 ** 31 - 1;
const RLS_REFUSED = "42501";

// With "any", a negated word would turn into "or not that word" and match almost everything.
const searchText = (query: string, match: "all" | "any") => {
  const text = query.replaceAll("\0", "");
  return match === "any" ? text.replace(/(^|\s)-\S*/g, "$1") : text;
};

const clampPassages = (limit: number) =>
  Math.min(Math.max(Math.trunc(limit) || DEFAULT_PASSAGES, 1), MAX_PASSAGES);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface SummaryRow {
  id: string;
  version_id: string;
  name: string;
  mime: string;
  size: string;
  status: Status;
  reason: string | null;
  page_count: number | null;
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
  status: row.status,
  failureReason: row.reason,
  pageCount: row.page_count,
  emptyPageCount: row.empty_page_count,
  matterId: row.matter_id,
  createdAt: row.created_at.toISOString(),
});

// Files stored before the queue existed have no job and were read at upload.
const SUMMARY_SQL = `
  select d.id, v.id version_id, d.name, d.mime, d.size,
         coalesce(j.status, 'indexed') status, j.reason, v.page_count,
         v.empty_page_count, d.matter_id, d.created_at
    from content.document d
    join content.document_version v on v.document_id = d.id
    left join content.ingest_job j on j.version_id = v.id
   where core.has_permission('threads.use')`;

export function createDocuments(pool: pg.Pool, options: DocumentsOptions): Documents {
  async function save(principal: Principal, input: UploadInput, mime: string, client: Client) {
    const { userId, workspaceId } = principal;
    const sha256 = createHash("sha256").update(input.bytes).digest();
    // First, so a row never points at a missing object; a retry reuses an orphan.
    await options.store.putIfAbsent(contentKey(workspaceId, sha256.toString("hex")), input.bytes);
    return asApp(pool, principal, async (db) => {
      const document = await db.query<{ id: string; created_at: Date }>(
        `insert into content.document (workspace_id, owner_id, matter_id, name, mime, size)
         values ($1, $2, $3, $4, $5, $6) returning id, created_at`,
        [workspaceId, userId, input.matterId, input.name, mime, input.bytes.length],
      );
      const row = document.rows[0];
      if (!row) throw new Error("insert returned no document");
      const version = await db.query<{ id: string }>(
        `insert into content.document_version (workspace_id, document_id, sha256, created_by)
         values ($1, $2, $3, $4) returning id`,
        [workspaceId, row.id, sha256, userId],
      );
      const versionId = version.rows[0]?.id;
      if (!versionId) throw new Error("insert returned no version");
      await db.query("insert into content.ingest_job (workspace_id, version_id) values ($1, $2)", [
        workspaceId,
        versionId,
      ]);
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
          }),
          client.ip,
          uaHash(client),
        ],
      );
      return toSummary({
        id: row.id,
        version_id: versionId,
        name: input.name,
        mime,
        size: String(input.bytes.length),
        status: "queued",
        reason: null,
        page_count: null,
        empty_page_count: 0,
        matter_id: input.matterId,
        created_at: row.created_at,
      });
    });
  }

  return {
    async upload(principal, input, client) {
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
      const mime = detectType(input.bytes, input.name);
      const refused =
        input.bytes.length > MAX_FILE_BYTES ? "FILE_TOO_LARGE" : mime ? null : "UNSUPPORTED_TYPE";
      if (refused || !mime) {
        await asApp(pool, principal, (db) =>
          db.query(
            "select admin.append_audit_event('document.ingest_failed', 'user', $1, null, null, $2, $3, $4)",
            [
              principal.userId,
              JSON.stringify({ failure_reason: refused, size: input.bytes.length }),
              client.ip,
              uaHash(client),
            ],
          ),
        );
        return { ok: false, reason: refused ?? "UNSUPPORTED_TYPE" };
      }
      try {
        return { ok: true, document: await save(principal, input, mime, client) };
      } catch (err) {
        // A wall or permission can change between the check and the insert.
        if ((err as { code?: string }).code === RLS_REFUSED) {
          return { ok: false, reason: "FORBIDDEN" };
        }
        throw err;
      }
    },

    async get(principal, documentId) {
      if (!UUID.test(documentId)) return null;
      return asApp(pool, principal, async (db) => {
        const { rows } = await db.query<SummaryRow>(`${SUMMARY_SQL} and d.id = $1`, [documentId]);
        return rows[0] ? toSummary(rows[0]) : null;
      });
    },

    async retry(principal, documentId) {
      if (!UUID.test(documentId)) return false;
      return asApp(pool, principal, async (db) => {
        const { rows } = await db.query<{ ok: boolean }>(
          `select content.retry_ingest_job(v.id) ok
             from content.document_version v where v.document_id = $1`,
          [documentId],
        );
        return rows.some((row) => row.ok);
      });
    },

    async search(
      principal,
      query,
      { limit = DEFAULT_PASSAGES, documentIds, versionIds, match = "all" } = {},
    ) {
      return asApp(pool, principal, async (db) => {
        // Row security rules out the text index, so these joins are what limit the scan.
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
             from (select case when $4 then replace(w::text, ' & ', ' | ')::tsquery else w end q
                     from websearch_to_tsquery('english', $1) w) words,
                  content.document d
             join content.document_version v on v.document_id = d.id
             join content.chunk c on c.version_id = v.id
            where c.tsv @@ q
              and core.has_permission('threads.use')
              and ($3::uuid[] is null or d.id = any($3::uuid[]))
              and ($5::uuid[] is null or v.id = any($5::uuid[]))
            order by ts_rank_cd(c.tsv, q) desc, c.id
            limit $2`,
          [
            searchText(query, match),
            clampPassages(limit),
            documentIds?.filter((id) => UUID.test(id)) ?? null,
            match === "any",
            versionIds?.filter((id) => UUID.test(id)) ?? null,
          ],
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
        const { rows } = await db.query<SummaryRow>(`${SUMMARY_SQL} order by d.id desc limit $1`, [
          LIST_LIMIT,
        ]);
        return rows.map(toSummary);
      });
    },
  };
}
