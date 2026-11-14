import { createHash } from "node:crypto";
import { fileTypeLimit, type RetrievalScope } from "@legallabs/contracts";
import { contextual, type Embedder, EmbedUnavailable, type Reranker } from "@legallabs/embed";
import { type Block, detectType, type Failure } from "@legallabs/ingest";
import { contentKey, type ObjectStore } from "@legallabs/storage";
import type pg from "pg";
import { type Client, type Principal, uaHash } from "../auth/auth.js";
import { asApp, RLS_REFUSED } from "../db.js";

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
  /** Files the upload into a vault, at the top or in a folder. */
  vaultId?: string;
  folderId?: string | null;
}

export type UploadResult =
  | { ok: true; document: Summary }
  | {
      ok: false;
      reason:
        | Extract<Failure, "UNSUPPORTED_TYPE" | "FILE_TOO_LARGE">
        | "FORBIDDEN"
        | "MATTER_NOT_FOUND"
        | "VAULT_FILE_LIMIT"
        | "VAULT_SIZE_LIMIT";
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
  /** Narrows the search to vaults, folders (with subfolders) and documents. */
  scope?: RetrievalScope;
  documentIds?: readonly string[];
  /** Pins a search to exact versions, as a thread that cites them needs. */
  versionIds?: readonly string[];
  /** "any" finds passages with some of the words, as a typed question needs. */
  match?: "all" | "any";
}

export interface Documents {
  /** Stores the file and queues it; reading it happens in the ingest worker. */
  upload(principal: Principal, input: UploadInput, client: Client): Promise<UploadResult>;
  /** The caller's newest documents outside vaults, up to a fixed page. */
  list(principal: Principal): Promise<Summary[]>;
  /** Null for anything the caller can't read. */
  get(principal: Principal, documentId: string): Promise<Summary | null>;
  /** Queues a failed file again. False if it isn't the caller's failed file. */
  retry(principal: Principal, documentId: string, client: Client): Promise<boolean>;
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
  /** Adds meaning-based matches to keyword search. Must be the model the worker used. */
  embedder?: Embedder | null;
  /** Reorders the best candidates with a cross-encoder. */
  reranker?: Reranker | null;
}

const LIST_LIMIT = 100;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
const DEFAULT_PASSAGES = 10;
export const MAX_PASSAGES = 50;
const MAX_INT = 2 ** 31 - 1;

// With "any", a negated word would turn into "or not that word" and match almost everything.
const searchText = (query: string, match: "all" | "any") => {
  const text = query.replaceAll("\0", "");
  return match === "any" ? text.replace(/(^|\s)-\S*/g, "$1") : text;
};

class NoRoom extends Error {
  constructor(readonly reason: "VAULT_FILE_LIMIT" | "VAULT_SIZE_LIMIT") {
    super(reason);
  }
}

// "Deed.pdf" becomes "Deed (2).pdf" when a folder already holds one.
const stem = (name: string) => {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
};

export function freeName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name.toLowerCase())) return name;
  const base = stem(name);
  const extension = name.slice(base.length);
  for (let n = 2; ; n++) {
    const next = `${base} (${n})${extension}`;
    if (!taken.has(next.toLowerCase())) return next;
  }
}

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

interface PassageRow {
  id: string;
  version_id: string;
  document_id: string;
  name: string;
  page_no: number;
  char_from: number;
  char_to: number;
  text: string;
  section: string | null;
}

const toPassage = (row: PassageRow): Passage => ({
  chunkId: row.id,
  documentId: row.document_id,
  documentVersionId: row.version_id,
  documentName: row.name,
  page: row.page_no,
  from: row.char_from,
  to: row.char_to,
  text: row.text,
});

// Enough for fusion and reranking to find what either list alone ranked low.
const CANDIDATES = 100;
// Without a floor the nearest chunks always come back, however unrelated.
const MAX_DISTANCE = 0.65;
// A question, not a document: longer text only slows every step that follows.
const MAX_QUERY = 2000;

export function createDocuments(pool: pg.Pool, options: DocumentsOptions): Documents {
  async function reranked(query: string, rows: PassageRow[]): Promise<PassageRow[]> {
    if (!options.reranker || rows.length < 2) return rows;
    try {
      const scores = await options.reranker.rerank(
        query,
        rows.map((row) => contextual(row.text, row.section)),
      );
      return rows
        .map((row, i) => ({ row, score: scores[i] ?? Number.NEGATIVE_INFINITY }))
        .sort((a, b) => b.score - a.score)
        .map(({ row }) => row);
    } catch (err) {
      // The fused order stands when the reranker is down.
      if (err instanceof EmbedUnavailable) return rows;
      throw err;
    }
  }

  async function save(principal: Principal, input: UploadInput, mime: string, client: Client) {
    const { userId, workspaceId } = principal;
    const sha256 = createHash("sha256").update(input.bytes).digest();
    // First, so a row never points at a missing object; a retry reuses an orphan.
    await options.store.putIfAbsent(contentKey(workspaceId, sha256.toString("hex")), input.bytes);
    return asApp(pool, principal, async (db) => {
      const vaultId = input.vaultId ?? null;
      const folderId = vaultId ? (input.folderId ?? null) : null;
      let name = input.name;
      if (vaultId) {
        // Holds the vault's lock until commit, so parallel uploads can't overshoot its limit.
        const room = await db.query<{ refused: NoRoom["reason"] | null }>(
          "select content.claim_vault_room($1, 1, $2) refused",
          [vaultId, input.bytes.length],
        );
        const refused = room.rows[0]?.refused;
        if (refused) throw new NoRoom(refused);
        const taken = await db.query<{ name: string }>(
          `select name from content.document
            where vault_id = $1 and folder_id is not distinct from $2
              and starts_with(lower(name), lower($3))`,
          [vaultId, folderId, stem(input.name)],
        );
        name = freeName(input.name, new Set(taken.rows.map((row) => row.name.toLowerCase())));
      }
      const document = await db.query<{ id: string; created_at: Date }>(
        `insert into content.document
           (workspace_id, owner_id, matter_id, name, mime, size, vault_id, folder_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8) returning id, created_at`,
        [workspaceId, userId, input.matterId, name, mime, input.bytes.length, vaultId, folderId],
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
        name,
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
      const vaultId = input.vaultId ?? null;
      const access = await asApp(pool, principal, async (db) => {
        const { rows } = await db.query<{ allowed: boolean; reachable: boolean }>(
          `select core.has_permission('threads.use')
                  and ($2::uuid is null
                       or coalesce(content.vault_level($2) in ('owner', 'full', 'edit'), false))
                  and ($3::uuid is null or exists (
                    select 1 from content.folder f where f.id = $3 and f.vault_id = $2)) allowed,
                  core.can_access_matter($1::uuid) reachable`,
          [input.matterId, vaultId, vaultId ? (input.folderId ?? null) : null],
        );
        return rows[0];
      });
      if (!access?.allowed) return { ok: false, reason: "FORBIDDEN" };
      if (!access.reachable) return { ok: false, reason: "MATTER_NOT_FOUND" };
      const mime = detectType(input.bytes, input.name);
      const typeLimit = fileTypeLimit(input.name)?.bytes ?? MAX_FILE_BYTES;
      const refused =
        input.bytes.length > Math.min(MAX_FILE_BYTES, typeLimit)
          ? "FILE_TOO_LARGE"
          : mime
            ? null
            : "UNSUPPORTED_TYPE";
      if (refused !== null || mime === null) {
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
        if (err instanceof NoRoom) return { ok: false, reason: err.reason };
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

    async retry(principal, documentId, client) {
      if (!UUID.test(documentId)) return false;
      return asApp(pool, principal, async (db) => {
        const { rows } = await db.query<{ id: string }>(
          `select v.id from content.document_version v
            where v.document_id = $1 and content.retry_ingest_job(v.id)`,
          [documentId],
        );
        if (rows.length === 0) return false;
        await db.query(
          "select admin.append_audit_event('document.ingest_retried', 'user', $1, 'document', $2, $3, $4, $5)",
          [
            principal.userId,
            documentId,
            JSON.stringify({ version_ids: rows.map((row) => row.id) }),
            client.ip,
            uaHash(client),
          ],
        );
        return true;
      });
    },

    async search(
      principal,
      query,
      { limit = DEFAULT_PASSAGES, scope, documentIds, versionIds, match = "all" } = {},
    ) {
      // Both lists narrow, so a document must be in each one given.
      const documents =
        documentIds && scope?.document_ids
          ? documentIds.filter((id) => scope.document_ids?.includes(id))
          : (scope?.document_ids ?? documentIds);
      query = query.slice(0, MAX_QUERY);
      const take = clampPassages(limit);
      // Embedded outside the transaction, so a slow model never holds a connection.
      let vector: string | null = null;
      if (options.embedder) {
        try {
          const [embedded] = await options.embedder.embed([query.replaceAll("\0", "")]);
          vector = embedded ? `[${embedded.join(",")}]` : null;
        } catch (err) {
          // Keyword search still answers when the model server is down.
          if (!(err instanceof EmbedUnavailable)) throw err;
        }
      }
      const rows = await asApp(pool, principal, async (db) => {
        // Folders first, as a plain list: inside the search the planner guesses badly.
        const folders = scope?.folder_ids
          ? (
              await db.query<{ id: string }>(
                `with recursive tree as (
                   select f.id from content.folder f where f.id = any($1::uuid[])
                   union
                   select f.id from content.folder f join tree on f.parent_id = tree.id
                 ) select id from tree`,
                [scope.folder_ids.filter((id) => UUID.test(id))],
              )
            ).rows.map((row) => row.id)
          : null;
        // Row security rules out both indexes, so the scope joins are what limit the scan.
        const result = await db.query<PassageRow>(
          `with words as (
             select case when $4 then replace(w::text, ' & ', ' | ')::tsquery else w end q
               from websearch_to_tsquery('english', $1) w
           ), scope as not materialized (
             select c.id, c.version_id, v.document_id, d.name, c.page_no, c.char_from, c.char_to,
                    c.text, c.section, c.tsv, c.embedding, c.embedding_model
               from content.document d
               join content.document_version v on v.document_id = d.id
               join content.chunk c on c.version_id = v.id
              where core.has_permission('threads.use')
                and ($3::uuid[] is null or d.id = any($3::uuid[]))
                and ($5::uuid[] is null or v.id = any($5::uuid[]))
                and ($10::uuid[] is null or d.vault_id = any($10::uuid[]))
                and ($11::uuid[] is null or d.folder_id = any($11::uuid[]))
           ), lexical as (
             select s.id, row_number() over (order by ts_rank_cd(s.tsv, w.q) desc, s.id) r
               from scope s, words w
              where s.tsv @@ w.q
              order by r limit $7
           ), dense as (
             select s.id, row_number() over (order by s.embedding <=> $6::vector, s.id) r
               from scope s
              where $6::vector is not null and s.embedding_model = $8
                and s.embedding <=> $6::vector <= $9
              order by r limit $7
           ), fused as (
             -- Reciprocal rank fusion: rank, not raw score, so the two lists can be compared.
             select id, sum(1.0 / (60 + r)) score
               from (select * from lexical union all select * from dense) ranked
              group by id
           )
           select s.id, s.version_id, s.document_id, s.name, s.page_no, s.char_from, s.char_to,
                  s.text, s.section
             from fused f join scope s on s.id = f.id
            order by f.score desc, s.id
            limit $2`,
          [
            searchText(query, match),
            options.reranker ? CANDIDATES : take,
            documents?.filter((id) => UUID.test(id)) ?? null,
            match === "any",
            versionIds?.filter((id) => UUID.test(id)) ?? null,
            vector,
            CANDIDATES,
            options.embedder?.model ?? null,
            MAX_DISTANCE,
            scope?.vault_ids?.filter((id) => UUID.test(id)) ?? null,
            folders,
          ],
        );
        return result.rows;
      });
      return (await reranked(query, rows)).slice(0, take).map(toPassage);
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
          `${SUMMARY_SQL} and d.vault_id is null order by d.id desc limit $1`,
          [LIST_LIMIT],
        );
        return rows.map(toSummary);
      });
    },
  };
}
