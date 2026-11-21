import {
  type AddRowsBody,
  type Column,
  type ColumnType,
  type CreateColumnBody,
  type CreateTableBody,
  DEFAULT_SETTINGS,
  type PatchColumnBody,
  type PatchTableBody,
  parseColumnOptions,
  type ReviewTable,
  type Row,
  type RowFilter,
  type RowSort,
  RT_LIMITS,
  Settings,
  type TableErrorCode,
} from "@legallabs/contracts";
import type { Gateway } from "@legallabs/model-gateway";
import type pg from "pg";
import type { Client, Principal } from "../auth/auth.js";
import { asApp, RLS_REFUSED } from "../db.js";
import { audit } from "./audit.js";
import { setStatus } from "./history.js";
import { columnProgress } from "./runner.js";

export type Db = pg.PoolClient;
export type Failure = { ok: false; code: TableErrorCode; message?: string; details?: object };
export type Result<T> = { ok: true; value: T } | Failure;
export const fail = (code: TableErrorCode, message?: string, details?: object): Failure => ({
  ok: false,
  code,
  ...(message ? { message } : {}),
  ...(details ? { details } : {}),
});

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TableRow {
  id: string;
  workspace_id: string;
  owner_id: string;
  name: string;
  source_kind: "vault" | "uploads";
  vault_id: string | null;
  folder_ids: string[] | null;
  thread_id: string | null;
  matter_id: string | null;
  instructions: string;
  settings: Record<string, unknown>;
  stats: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export interface ColumnRow {
  id: string;
  ordinal: number;
  label: string;
  type: ColumnType;
  prompt: string;
  language: string | null;
  model: string | null;
  context_document_id: string | null;
  options: Record<string, unknown>;
  state: Column["state"];
  dry_run: boolean;
  run_id: string | null;
}

export const settingsOf = (table: Pick<TableRow, "settings">): Settings =>
  Settings.safeParse({ ...DEFAULT_SETTINGS, ...table.settings }).data ?? DEFAULT_SETTINGS;

/** The table as the caller sees it, or null when hidden or deleted. */
export async function loadTable(db: Db, tableId: string): Promise<TableRow | null> {
  if (!UUID.test(tableId)) return null;
  const { rows } = await db.query<TableRow>("select * from work.review_table where id = $1", [
    tableId,
  ]);
  return rows[0] ?? null;
}

export async function loadColumns(db: Db, tableId: string): Promise<ColumnRow[]> {
  const { rows } = await db.query<ColumnRow>(
    `select id, ordinal, label, type, prompt, language, model, context_document_id, options, state,
            dry_run, run_id
       from work.rt_column where table_id = $1 and deleted_at is null order by ordinal, id`,
    [tableId],
  );
  return rows;
}

async function tableJson(db: Db, table: TableRow, userId: string): Promise<ReviewTable> {
  const { rows } = await db.query<{
    rows: number;
    columns: number;
    starred: boolean;
    done: number;
    null: number;
    error: number;
    cost: string;
    citations: string;
    verified: string;
  }>(
    `select (select count(*)::int from work.rt_row r where r.table_id = $1 and r.deleted_at is null) rows,
            (select count(*)::int from work.rt_column k
              where k.table_id = $1 and k.deleted_at is null) columns,
            exists (select 1 from work.rt_star s where s.table_id = $1 and s.user_id = $2) starred,
            count(*) filter (where c.status = 'done')::int done,
            count(*) filter (where c.status = 'null')::int "null",
            count(*) filter (where c.status = 'error')::int error,
            coalesce(sum(c.cost_usd), 0) cost,
            coalesce(sum(c.citation_count), 0) citations,
            coalesce(sum(c.verified_citation_count), 0) verified
       from work.rt_cell c
       join work.rt_row r on r.id = c.row_id and r.deleted_at is null
       join work.rt_column k on k.id = c.column_id and k.deleted_at is null
      where c.table_id = $1`,
    [table.id, userId],
  );
  const s = rows[0];
  const citations = Number(s?.citations ?? 0);
  return {
    id: table.id,
    workspace_id: table.workspace_id,
    owner_id: table.owner_id,
    name: table.name,
    source_kind: table.source_kind,
    vault_id: table.vault_id,
    folder_ids: table.folder_ids,
    thread_id: table.thread_id,
    matter_id: table.matter_id,
    instructions: table.instructions,
    settings: settingsOf(table),
    stats: {
      rows: s?.rows ?? 0,
      columns: s?.columns ?? 0,
      cells_done: s?.done ?? 0,
      cells_null: s?.null ?? 0,
      cells_error: s?.error ?? 0,
      cost_usd: Number(s?.cost ?? 0),
      valid_citation_rate: citations > 0 ? Number(s?.verified ?? 0) / citations : null,
    },
    starred: s?.starred ?? false,
    created_at: table.created_at.toISOString(),
    updated_at: table.updated_at.toISOString(),
  };
}

export async function columnJson(db: Db, column: ColumnRow): Promise<Column> {
  return {
    id: column.id,
    ordinal: column.ordinal,
    label: column.label,
    type: column.type,
    prompt: column.prompt,
    language: column.language,
    model: column.model,
    context_document_id: column.context_document_id,
    options: column.options,
    state: column.state,
    dry_run: column.dry_run,
    progress: await columnProgress(db, column.id),
    run_id: column.run_id,
  };
}

/** Document names and states for rows; a hidden document shows no name. */
export async function rowsJson(
  db: Db,
  rows: readonly {
    id: string;
    ordinal: number;
    document_ids: string[];
    flag_color: string | null;
    locked: boolean;
    restricted: boolean;
  }[],
): Promise<Row[]> {
  const ids = [...new Set(rows.flatMap((r) => r.document_ids))];
  const { rows: docs } = await db.query<{
    id: string;
    name: string;
    version_no: number;
    status: string;
  }>(
    `select d.id, d.name, coalesce(v.version_no, 1) version_no,
            coalesce(j.status, 'indexed') status
       from content.document d
       left join lateral (select id, version_no from content.document_version
                           where document_id = d.id order by version_no desc limit 1) v on true
       left join content.ingest_job j on j.version_id = v.id
      where d.id = any($1::uuid[])`,
    [ids],
  );
  const byId = new Map(docs.map((d) => [d.id, d]));
  return rows.map((r) => ({
    id: r.id,
    ordinal: r.ordinal,
    document_ids: r.document_ids,
    documents: r.document_ids.map((id) => {
      const d = byId.get(id);
      return d
        ? { id, name: d.name, status: d.status, version_no: d.version_no }
        : { id, name: "Restricted document", status: "restricted", version_no: 0 };
    }),
    restricted: r.restricted,
    flag_color: r.flag_color as Row["flag_color"],
    locked: r.locked,
  }));
}

/** Rows for documents, after any already in the table; every live column gets a pending cell. */
async function insertRows(
  db: Db,
  principal: Principal,
  tableId: string,
  documentIds: readonly string[],
): Promise<string[]> {
  if (documentIds.length === 0) return [];
  const { rows } = await db.query<{ id: string }>(
    `insert into work.rt_row (workspace_id, table_id, ordinal, document_ids)
     select $1, $2,
            (select coalesce(max(ordinal) + 1, 0) from work.rt_row where table_id = $2) + u.o - 1,
            array[u.id]
       from unnest($3::uuid[]) with ordinality u(id, o)
     returning id`,
    [principal.workspaceId, tableId, documentIds],
  );
  const rowIds = rows.map((r) => r.id);
  await db.query(
    `insert into work.rt_cell (workspace_id, table_id, row_id, column_id)
     select $1, $2, r, k.id from unnest($3::uuid[]) r, work.rt_column k
      where k.table_id = $2 and k.deleted_at is null`,
    [principal.workspaceId, tableId, rowIds],
  );
  return rowIds;
}

interface Source {
  kind: "vault" | "uploads";
  vaultId: string | null;
  folderIds: string[] | null;
  matterId: string | null;
  threadId: string | null;
  documentIds: string[];
  defaultName: string;
}

async function resolveSource(
  db: Db,
  body: CreateTableBody,
  vaultLimit: number,
): Promise<Result<Source>> {
  const source = body.source;
  if (source.kind === "vault") {
    const { rows } = await db.query<{ name: string; matter_id: string | null }>(
      `select name, matter_id from content.vault
        where id = $1 and deleted_at is null and content.vault_level(id) is not null`,
      [source.vault_id],
    );
    const vault = rows[0];
    if (!vault) return fail("NOT_FOUND", "That vault wasn't found.");
    let folders: string[] | null = null;
    if (source.folder_ids) {
      const given = [...new Set(source.folder_ids)];
      const { rows: tree } = await db.query<{ id: string; given: boolean }>(
        `with recursive tree as (
           select f.id, true given from content.folder f
            where f.id = any($1::uuid[]) and f.vault_id = $2 and f.deleted_at is null
           union
           select f.id, false from content.folder f join tree on f.parent_id = tree.id
            where f.deleted_at is null
         ) select id, given from tree`,
        [given, source.vault_id],
      );
      if (tree.filter((f) => f.given).length !== given.length) {
        return fail("SOURCE_MISMATCH", "A folder isn't in this vault.");
      }
      folders = tree.map((f) => f.id);
    }
    const wanted = source.document_ids ? [...new Set(source.document_ids)] : null;
    const { rows: docs } = await db.query<{ id: string }>(
      `select d.id from content.document d
        where d.vault_id = $1
          and ($2::uuid[] is null or d.folder_id = any($2::uuid[]))
          and ($3::uuid[] is null or d.id = any($3::uuid[]))
        order by lower(d.name), d.id
        limit $4`,
      [source.vault_id, folders, wanted, vaultLimit + 1],
    );
    if (wanted && docs.length !== wanted.length) {
      return fail("SOURCE_MISMATCH", "Some files aren't in this vault.");
    }
    if (docs.length > vaultLimit) {
      return fail(
        "SOURCE_LIMIT",
        `A table holds up to ${vaultLimit.toLocaleString("en")} files. Choose folders or files instead.`,
        { limit: vaultLimit },
      );
    }
    return {
      ok: true,
      value: {
        kind: "vault",
        vaultId: source.vault_id,
        folderIds: source.folder_ids ?? null,
        matterId: vault.matter_id,
        threadId: null,
        documentIds: docs.map((d) => d.id),
        defaultName: `Review of ${vault.name}`.slice(0, 200),
      },
    };
  }

  let docs: { id: string; vault_id: string | null; matter_id: string | null }[];
  let threadId: string | null = null;
  let threadMatter: string | null = null;
  if (source.kind === "uploads") {
    const wanted = [...new Set(source.upload_ids)];
    const found = await db.query<{ id: string; vault_id: null; matter_id: string | null }>(
      `select d.id, d.vault_id, d.matter_id from content.document d
        where d.id = any($1::uuid[]) and d.vault_id is null
        order by array_position($1::uuid[], d.id)`,
      [wanted],
    );
    if (found.rows.length !== wanted.length) {
      return fail("SOURCE_MISMATCH", "Some files weren't found among your uploads.");
    }
    docs = found.rows;
  } else {
    const thread = await db.query<{ matter_id: string | null }>(
      "select matter_id from work.thread where id = $1",
      [source.thread_id],
    );
    if (!thread.rows[0]) return fail("NOT_FOUND", "That thread wasn't found.");
    threadId = source.thread_id;
    threadMatter = thread.rows[0].matter_id;
    const found = await db.query<{ id: string; vault_id: string | null; matter_id: string | null }>(
      `select distinct on (lower(d.name), d.id) d.id, d.vault_id, d.matter_id
         from work.thread_document td
         join content.document_version v on v.id = td.version_id
         join content.document d on d.id = v.document_id
        where td.thread_id = $1
        order by lower(d.name), d.id`,
      [source.thread_id],
    );
    docs = found.rows;
  }
  if (docs.length === 0) return fail("SOURCE_EMPTY", "There are no files to put in a table.");
  if (docs.length > RT_LIMITS.uploads && docs.every((d) => d.vault_id === null)) {
    return fail("SOURCE_LIMIT", "A table of uploads holds up to 50 files.", {
      limit: RT_LIMITS.uploads,
    });
  }
  // One table, one source: never uploads and a vault, nor two vaults.
  const vaults = new Set(docs.map((d) => d.vault_id));
  const matters = new Set(docs.map((d) => d.matter_id));
  if (vaults.size > 1 || matters.size > 1) {
    return fail("SOURCE_MIXED", "One table, one source: these files come from different places.");
  }
  const vaultId = docs[0]?.vault_id ?? null;
  return {
    ok: true,
    value: {
      kind: vaultId ? "vault" : "uploads",
      vaultId,
      folderIds: null,
      matterId: docs[0]?.matter_id ?? threadMatter,
      threadId,
      documentIds: docs.map((d) => d.id),
      defaultName: "Untitled review",
    },
  };
}

export interface ListOptions {
  starred?: boolean;
  q?: string;
  offset?: number;
}

export function createTables(
  pool: pg.Pool,
  deps: { gateway: Gateway; vaultDocumentLimit?: number },
) {
  const vaultLimit = deps.vaultDocumentLimit ?? RT_LIMITS.vaultDocuments;
  const withTable = <T>(
    principal: Principal,
    tableId: string,
    work: (db: Db, table: TableRow) => Promise<Result<T>>,
  ): Promise<Result<T>> =>
    asApp(pool, principal, async (db) => {
      const table = await loadTable(db, tableId);
      if (!table) return fail("NOT_FOUND");
      return work(db, table);
    });

  const modelAllowed = (model: string | null | undefined) =>
    !model || deps.gateway.models("read_extract").some((m) => m.id === model);

  async function contextFileFits(db: Db, table: TableRow, documentId: string | null | undefined) {
    if (!documentId) return true;
    const { rows } = await db.query<{ vault_id: string | null }>(
      "select vault_id from content.document where id = $1",
      [documentId],
    );
    const doc = rows[0];
    return doc !== undefined && doc.vault_id === table.vault_id;
  }

  return {
    async create(
      principal: Principal,
      body: CreateTableBody,
      client: Client,
    ): Promise<Result<{ table: ReviewTable }>> {
      try {
        return await asApp(pool, principal, async (db) => {
          const resolved = await resolveSource(db, body, vaultLimit);
          if (!resolved.ok) return resolved;
          const s = resolved.value;
          const { rows } = await db.query<TableRow>(
            `insert into work.review_table
               (workspace_id, owner_id, name, source_kind, vault_id, folder_ids, thread_id,
                matter_id, settings)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning *`,
            [
              principal.workspaceId,
              principal.userId,
              body.name ?? s.defaultName,
              s.kind,
              s.vaultId,
              s.folderIds,
              s.threadId,
              s.matterId ?? body.matter_id ?? null,
              JSON.stringify(DEFAULT_SETTINGS),
            ],
          );
          const table = rows[0] as TableRow;
          await insertRows(db, principal, table.id, s.documentIds);
          await audit(db, principal, client, "table.created", table.id, {
            source_kind: s.kind,
            vault_id: s.vaultId,
            thread_id: s.threadId,
            rows: s.documentIds.length,
          });
          return { ok: true, value: { table: await tableJson(db, table, principal.userId) } };
        });
      } catch (err) {
        if ((err as { code?: string }).code === RLS_REFUSED) {
          return fail("FORBIDDEN", "You can't create review tables.");
        }
        throw err;
      }
    },

    list(principal: Principal, options: ListOptions) {
      return asApp(pool, principal, async (db) => {
        const limit = 50;
        const { rows } = await db.query<TableRow>(
          `select t.* from work.review_table t
            where ($1::text is null or t.name ilike '%' || $1 || '%')
              and (not $2 or exists (select 1 from work.rt_star s
                                      where s.table_id = t.id and s.user_id = $3))
            order by t.updated_at desc, t.id desc limit $4 offset $5`,
          [
            options.q?.replace(/[\\%_]/g, (ch) => `\\${ch}`) ?? null,
            options.starred === true,
            principal.userId,
            limit + 1,
            options.offset ?? 0,
          ],
        );
        const items = await Promise.all(
          rows.slice(0, limit).map((t) => tableJson(db, t, principal.userId)),
        );
        return {
          items,
          next_cursor: rows.length > limit ? String((options.offset ?? 0) + limit) : null,
        };
      });
    },

    get(principal: Principal, tableId: string) {
      return withTable(principal, tableId, async (db, table) => {
        const columns = await loadColumns(db, tableId);
        return {
          ok: true,
          value: {
            table: await tableJson(db, table, principal.userId),
            columns: await Promise.all(columns.map((c) => columnJson(db, c))),
            my_access: "owner" as const,
          },
        };
      });
    },

    update(principal: Principal, tableId: string, body: PatchTableBody, client: Client) {
      return withTable(principal, tableId, async (db, table) => {
        const settings = body.settings ? { ...settingsOf(table), ...body.settings } : null;
        const { rows } = await db.query<TableRow>(
          `update work.review_table
              set name = coalesce($2, name), instructions = coalesce($3, instructions),
                  settings = coalesce($4, settings), updated_at = now()
            where id = $1 returning *`,
          [
            tableId,
            body.name ?? null,
            body.instructions ?? null,
            settings && JSON.stringify(settings),
          ],
        );
        let stale = 0;
        if (body.instructions !== undefined && body.instructions !== table.instructions) {
          // New instructions change every answer, but nothing re-runs until someone asks.
          stale = await setStatus(
            db,
            principal,
            "c.table_id = $3 and c.status in ('done', 'null')",
            [tableId],
            "'stale'",
          );
        }
        await audit(db, principal, client, "table.updated", tableId, {
          fields: Object.keys(body),
          stale_cells: stale,
        });
        return {
          ok: true,
          value: { table: await tableJson(db, rows[0] as TableRow, principal.userId) },
        };
      });
    },

    remove(principal: Principal, tableId: string, client: Client) {
      return withTable(principal, tableId, async (db) => {
        await db.query("update work.review_table set deleted_at = now() where id = $1", [tableId]);
        await audit(db, principal, client, "table.deleted", tableId);
        return { ok: true, value: null };
      });
    },

    star(principal: Principal, tableId: string, on: boolean, client: Client) {
      return withTable(principal, tableId, async (db) => {
        await db.query(
          on
            ? `insert into work.rt_star (workspace_id, table_id, user_id) values ($1, $2, $3)
               on conflict do nothing`
            : "delete from work.rt_star where table_id = $2 and user_id = $3 and workspace_id = $1",
          [principal.workspaceId, tableId, principal.userId],
        );
        await audit(db, principal, client, "table.starred", tableId, { starred: on });
        return { ok: true, value: null };
      });
    },

    addRows(principal: Principal, tableId: string, body: AddRowsBody, client: Client) {
      return withTable(principal, tableId, async (db, table) => {
        const wanted = [...new Set(body.document_ids)];
        const { rows: docs } = await db.query<{ id: string }>(
          `select d.id from content.document d
            where d.id = any($1::uuid[]) and d.vault_id is not distinct from $2
            order by array_position($1::uuid[], d.id)`,
          [wanted, table.vault_id],
        );
        if (docs.length !== wanted.length) {
          return fail("SOURCE_MISMATCH", "Rows can only come from this table's source.");
        }
        const { rows: present } = await db.query<{ id: string }>(
          `select distinct unnest(document_ids) id from work.rt_row
            where table_id = $1 and deleted_at is null`,
          [tableId],
        );
        const have = new Set(present.map((p) => p.id));
        const fresh = docs.map((d) => d.id).filter((id) => !have.has(id));
        const cap = table.source_kind === "uploads" ? RT_LIMITS.uploads : vaultLimit;
        if (have.size + fresh.length > cap) {
          return fail("SOURCE_LIMIT", `A table of this source holds up to ${cap} files.`, {
            limit: cap,
          });
        }
        const rowIds = await insertRows(db, principal, tableId, fresh);
        if (rowIds.length > 0) {
          await audit(db, principal, client, "table.rows.added", tableId, { rows: rowIds.length });
        }
        const { rows } = await db.query<{
          id: string;
          ordinal: number;
          document_ids: string[];
          flag_color: string | null;
          locked: boolean;
          restricted: boolean;
        }>(
          `select id, ordinal, document_ids, flag_color, locked, false restricted
             from work.rt_row where id = any($1::uuid[]) order by ordinal`,
          [rowIds],
        );
        return { ok: true, value: { rows: await rowsJson(db, rows) } };
      });
    },

    createColumn(principal: Principal, tableId: string, body: CreateColumnBody, client: Client) {
      return withTable(principal, tableId, async (db, table) => {
        const options = parseColumnOptions(body.type, body.options);
        if (!options.success) return fail("INVALID_REQUEST", options.error);
        if (!modelAllowed(body.model)) return fail("MODEL_NOT_ALLOWED");
        if (!(await contextFileFits(db, table, body.context_document_id))) {
          return fail(
            "CONTEXT_FILE_SOURCE_MISMATCH",
            "The context file must come from this table's source.",
          );
        }
        const { rows: count } = await db.query<{ n: number; next: number }>(
          `select count(*)::int n, coalesce(max(ordinal) + 1, 0)::int next
             from work.rt_column where table_id = $1 and deleted_at is null`,
          [tableId],
        );
        if ((count[0]?.n ?? 0) >= RT_LIMITS.columns) {
          return fail("COLUMN_LIMIT", "A table holds up to 500 columns.", {
            limit: RT_LIMITS.columns,
          });
        }
        let ordinal = count[0]?.next ?? 0;
        if (body.position !== undefined && body.position < ordinal) {
          ordinal = body.position;
          await db.query(
            `update work.rt_column set ordinal = ordinal + 1
              where table_id = $1 and deleted_at is null and ordinal >= $2`,
            [tableId, ordinal],
          );
        }
        let column: ColumnRow;
        try {
          const { rows } = await db.query<ColumnRow>(
            `insert into work.rt_column
               (workspace_id, table_id, ordinal, label, type, prompt, language, model,
                context_document_id, options)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             returning id, ordinal, label, type, prompt, language, model, context_document_id,
                       options, state, dry_run, run_id`,
            [
              principal.workspaceId,
              tableId,
              ordinal,
              body.label,
              body.type,
              body.prompt,
              body.language ?? settingsOf(table).default_language,
              body.model ?? null,
              body.context_document_id ?? null,
              JSON.stringify(options.data),
            ],
          );
          column = rows[0] as ColumnRow;
        } catch (err) {
          if ((err as Error).message === "COLUMN_LIMIT") return fail("COLUMN_LIMIT");
          throw err;
        }
        await db.query(
          `insert into work.rt_cell (workspace_id, table_id, row_id, column_id)
           select $1, $2, r.id, $3 from work.rt_row r where r.table_id = $2 and r.deleted_at is null`,
          [principal.workspaceId, tableId, column.id],
        );
        await audit(db, principal, client, "table.column.added", tableId, {
          column_id: column.id,
          type: column.type,
        });
        return { ok: true, value: { column: await columnJson(db, column) } };
      });
    },

    updateColumn(
      principal: Principal,
      tableId: string,
      columnId: string,
      body: PatchColumnBody,
      client: Client,
    ) {
      return withTable(principal, tableId, async (db, table) => {
        const column = (await loadColumns(db, tableId)).find((c) => c.id === columnId);
        if (!column) return fail("NOT_FOUND");
        if (column.state === "running") return fail("COLUMN_RUNNING", "Stop the run first.");
        const type = body.type ?? column.type;
        const typeChanged = type !== column.type;
        const options = parseColumnOptions(
          type,
          body.options !== undefined ? body.options : typeChanged ? {} : column.options,
        );
        if (!options.success) return fail("INVALID_REQUEST", options.error);
        if (body.model !== undefined && !modelAllowed(body.model)) return fail("MODEL_NOT_ALLOWED");
        if (!(await contextFileFits(db, table, body.context_document_id))) {
          return fail("CONTEXT_FILE_SOURCE_MISMATCH");
        }
        const { rows } = await db.query<ColumnRow>(
          `update work.rt_column
              set label = $2, type = $3, prompt = $4, language = $5, model = $6,
                  context_document_id = $7, options = $8, updated_at = now()
            where id = $1
           returning id, ordinal, label, type, prompt, language, model, context_document_id,
                     options, state, dry_run, run_id`,
          [
            columnId,
            body.label ?? column.label,
            type,
            body.prompt ?? column.prompt,
            body.language ?? column.language,
            body.model !== undefined ? body.model : column.model,
            body.context_document_id !== undefined
              ? body.context_document_id
              : column.context_document_id,
            JSON.stringify(options.data),
          ],
        );
        const changesAnswers = [
          "type",
          "prompt",
          "options",
          "model",
          "language",
          "context_document_id",
        ].some((k) => k in body);
        let stale = 0;
        if (changesAnswers) {
          stale = await setStatus(
            db,
            principal,
            "c.column_id = $3 and c.status in ('done', 'null')",
            [columnId],
            "'stale'",
          );
        }
        await audit(db, principal, client, "table.column.updated", tableId, {
          column_id: columnId,
          fields: Object.keys(body),
          stale_cells: stale,
        });
        return {
          ok: true,
          value: { column: await columnJson(db, rows[0] as ColumnRow), stale_cells: stale },
        };
      });
    },

    removeColumn(principal: Principal, tableId: string, columnId: string, client: Client) {
      return withTable(principal, tableId, async (db) => {
        if (!UUID.test(columnId)) return fail("NOT_FOUND");
        const { rows } = await db.query<{ run_id: string | null; state: string }>(
          `update work.rt_column set deleted_at = now(), updated_at = now()
            where id = $1 and table_id = $2 and deleted_at is null returning run_id, state`,
          [columnId, tableId],
        );
        if (!rows[0]) return fail("NOT_FOUND");
        await audit(db, principal, client, "table.column.deleted", tableId, {
          column_id: columnId,
        });
        return { ok: true, value: { run_id: rows[0].state === "running" ? rows[0].run_id : null } };
      });
    },

    reorder(principal: Principal, tableId: string, columnIds: readonly string[], client: Client) {
      return withTable(principal, tableId, async (db) => {
        const live = await loadColumns(db, tableId);
        const ids = new Set(live.map((c) => c.id));
        if (columnIds.length !== ids.size || !columnIds.every((id) => ids.has(id))) {
          return fail("INVALID_REQUEST", "List every column of the table once.");
        }
        await db.query(
          `update work.rt_column k set ordinal = u.o - 1, updated_at = now()
             from unnest($1::uuid[]) with ordinality u(id, o) where k.id = u.id`,
          [columnIds],
        );
        await audit(db, principal, client, "table.column.updated", tableId, { reordered: true });
        return { ok: true, value: null };
      });
    },
  };
}

export type Tables = ReturnType<typeof createTables>;
export type { RowFilter, RowSort };
