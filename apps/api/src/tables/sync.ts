import {
  inRunOrder,
  type PutSyncBody,
  type SyncAddedRowsEvent,
  type SyncResult,
  type SyncStatus,
} from "@legallabs/contracts";
import type pg from "pg";
import type { Client, Principal } from "../auth/auth.js";
import { asApp, asWorker } from "../db.js";
import { audit } from "./audit.js";
import type { Cells } from "./cells.js";
import {
  type Db,
  fail,
  insertRows,
  loadColumns,
  loadTable,
  type Result,
  type TableRow,
} from "./tables.js";

/** Where a pass reports that it added rows, when the owner asked to hear about it. */
export type SyncEvents = (event: SyncAddedRowsEvent) => void | Promise<void>;

export interface SyncOptions {
  cells: Pick<Cells, "runRows">;
  events?: SyncEvents;
  /** How often the background job looks for tables due a pass. */
  intervalMs?: number;
  log?: (line: string) => void;
}

export interface TableSync {
  status(principal: Principal, tableId: string): Promise<Result<SyncStatus>>;
  configure(
    principal: Principal,
    tableId: string,
    body: PutSyncBody,
    client: Client,
  ): Promise<Result<SyncStatus>>;
  /** One pass now: adds rows for new files and runs the columns that have run before. */
  run(principal: Principal, tableId: string, client: Client): Promise<Result<SyncResult>>;
  /** One pass over every table with sync on, each as its owner (tests narrow it to one workspace). */
  runDue(onlyWorkspace?: string): Promise<number>;
  start(): void;
  stop(): Promise<void>;
}

const NO_CLIENT: Client = { ip: null, userAgent: null };

/** A folder and everything under it, for the folders a table syncs. */
async function folderTree(db: Db, vaultId: string, folderIds: readonly string[]) {
  const { rows } = await db.query<{ id: string; given: boolean }>(
    `with recursive tree as (
       select f.id, true given from content.folder f
        where f.id = any($1::uuid[]) and f.vault_id = $2 and f.deleted_at is null
       union
       select f.id, false from content.folder f join tree on f.parent_id = tree.id
        where f.deleted_at is null
     ) select id, given from tree`,
    [folderIds, vaultId],
  );
  return { all: rows.map((r) => r.id), given: rows.filter((r) => r.given).length };
}

const REAL_COLUMNS = `k.deleted_at is null and k.type <> 'manual'`;

export function createTableSync(pool: pg.Pool, options: SyncOptions): TableSync {
  const { cells, events, log } = options;
  const INTERVAL_MS = options.intervalMs ?? 30_000;
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<unknown> | null = null;

  async function statusOf(db: Db, table: TableRow): Promise<SyncStatus> {
    const { rows } = await db.query<{ pending: number; removed: number }>(
      `select count(*) filter (where r.sync_pending or (r.version_no is not null and exists (
                select 1 from work.rt_cell c
                 where c.row_id = r.id and c.status in ('queued', 'running', 'blocked'))))::int pending,
              count(*) filter (where r.source_removed)::int removed
         from work.rt_row r where r.table_id = $1 and r.deleted_at is null`,
      [table.id],
    );
    const pending = table.sync_mode === "off" ? 0 : (rows[0]?.pending ?? 0);
    return {
      mode: table.sync_mode,
      folder_ids: table.sync_folder_ids,
      notify: table.sync_notify,
      state: table.sync_mode === "off" ? "off" : pending > 0 ? "pending" : "idle",
      pending_rows: pending,
      removed_rows: rows[0]?.removed ?? 0,
      last_synced_at: table.last_synced_at?.toISOString() ?? null,
    };
  }

  /** The database half of a pass: rows for new files and versions, flags for gone ones. */
  async function sync(db: Db, principal: Principal, client: Client, table: TableRow) {
    // One pass at a time per table, so a manual pass and the job can't both add the same file.
    await db.query("select pg_advisory_xact_lock(hashtextextended($1, 2))", [table.id]);
    let scope: string[] | null = null;
    if (table.sync_mode === "selected_folders" && table.sync_folder_ids) {
      scope = (await folderTree(db, table.vault_id ?? "", table.sync_folder_ids)).all;
    }
    // Every file the owner can see in the vault, with its newest version and whether it is read.
    const { rows: files } = await db.query<{
      id: string;
      folder_id: string | null;
      version_id: string;
      version_no: number;
      ready: boolean;
    }>(
      `select d.id, d.folder_id, v.id version_id, v.version_no,
              coalesce(j.status, 'indexed') = 'indexed' ready
         from content.document d
         join lateral (select id, version_no from content.document_version
                        where document_id = d.id order by version_no desc limit 1) v on true
         left join content.ingest_job j on j.version_id = v.id
        where d.vault_id = $1
        order by lower(d.name), d.id`,
      [table.vault_id],
    );
    const { rows: held } = await db.query<{
      id: string;
      doc: string;
      version_no: number | null;
      removed: boolean;
    }>(
      `select r.id, unnest(r.document_ids) doc, r.version_no, r.source_removed removed
         from work.rt_row r where r.table_id = $1 and r.deleted_at is null`,
      [table.id],
    );
    const newest = new Map<string, number | null>();
    for (const row of held) {
      // A row nobody pinned stands for whatever the file is now, so it covers every version.
      const covered = row.version_no ?? Number.POSITIVE_INFINITY;
      newest.set(row.doc, Math.max(newest.get(row.doc) ?? 0, covered));
    }
    const inScope = (folder: string | null) =>
      scope === null || (folder !== null && scope.includes(folder));
    const fresh = files.filter(
      (f) => f.ready && inScope(f.folder_id) && (newest.get(f.id) ?? 0) < f.version_no,
    );
    const versions = fresh.filter((f) => newest.has(f.id)).length;
    const added = await insertRows(
      db,
      principal,
      table.id,
      fresh.map((f) => f.id),
      {
        pins: fresh.map((f) => ({ versionId: f.version_id, versionNo: f.version_no })),
        syncPending: true,
      },
    );

    // Rows whose file is gone from the vault keep their cells but are flagged; one that comes
    // back (restored from the bin) is unflagged.
    const present = new Set(files.map((f) => f.id));
    const gone = new Set(held.filter((h) => !present.has(h.doc)).map((h) => h.id));
    const flagged = new Set(held.filter((h) => h.removed).map((h) => h.id));
    const newlyGone = [...gone].filter((id) => !flagged.has(id));
    const back = [...flagged].filter((id) => !gone.has(id));
    if (newlyGone.length > 0) {
      await db.query("update work.rt_row set source_removed = true where id = any($1::uuid[])", [
        newlyGone,
      ]);
    }
    if (back.length > 0) {
      await db.query("update work.rt_row set source_removed = false where id = any($1::uuid[])", [
        back,
      ]);
    }
    await db.query("update work.review_table set last_synced_at = now() where id = $1", [table.id]);
    if (added.length > 0) {
      await audit(db, principal, client, "table.sync.rows_added", table.id, {
        rows: added.length,
        new_versions: versions,
      });
    }
    if (newlyGone.length > 0) {
      await audit(db, principal, client, "table.sync.source_removed", table.id, {
        rows: newlyGone.length,
      });
    }
    return { added: added.length, versions, removed: newlyGone.length, restored: back.length };
  }

  /** Starts each column that has run before on the rows sync added, dependencies first. */
  async function startColumns(principal: Principal, client: Client, tableId: string) {
    const { eligible, pendingRows } = await asApp(pool, principal, async (db) => {
      const columns = await loadColumns(db, tableId);
      const { rows } = await db.query<{ id: string }>(
        "select id from work.rt_row where table_id = $1 and deleted_at is null and sync_pending",
        [tableId],
      );
      return {
        // Columns that have never run wait for the user, as do manual ones.
        eligible: inRunOrder(
          columns.filter(
            (c) => c.type !== "manual" && ["done", "partial", "stopped"].includes(c.state),
          ),
        ),
        pendingRows: rows.map((r) => r.id),
      };
    });
    let runs = 0;
    if (pendingRows.length > 0) {
      for (const column of eligible) {
        // Only cells that haven't been asked yet: a row sync retried keeps what already ran.
        const rowIds = await asApp(pool, principal, async (db) => {
          const { rows } = await db.query<{ row_id: string }>(
            `select c.row_id from work.rt_cell c
              where c.column_id = $1 and c.row_id = any($2::uuid[]) and c.status in ('pending', 'blocked')`,
            [column.id, pendingRows],
          );
          return rows.map((r) => r.row_id);
        });
        if (rowIds.length === 0) continue;
        const started = await cells.runRows(principal, tableId, column.id, rowIds, client);
        if (started.ok && started.value.run_id) runs += 1;
      }
    }
    // A row is settled once no cell of a real column is still waiting to be asked.
    await asApp(pool, principal, (db) =>
      db.query(
        `update work.rt_row r set sync_pending = false
          where r.table_id = $1 and r.sync_pending
            and not exists (
              select 1 from work.rt_cell c join work.rt_column k on k.id = c.column_id
               where c.row_id = r.id and c.status = 'pending' and ${REAL_COLUMNS}
                 and k.state in ('done', 'partial', 'stopped', 'running'))`,
        [tableId],
      ),
    );
    return runs;
  }

  async function pass(
    principal: Principal,
    tableId: string,
    client: Client,
  ): Promise<Result<SyncResult>> {
    const done = await asApp(pool, principal, async (db) => {
      const table = await loadTable(db, tableId);
      if (!table) return fail("NOT_FOUND");
      if (table.sync_mode === "off") return fail("SYNC_DISABLED", "Turn sync on first.");
      return { ok: true as const, value: { table, ...(await sync(db, principal, client, table)) } };
    });
    if (!done.ok) return done;
    const { table, added, versions, removed, restored } = done.value;
    const runs = await startColumns(principal, client, tableId);
    if (added > 0 && table.sync_notify && events) {
      try {
        await events({
          type: "table.sync_added_rows",
          workspace_id: table.workspace_id,
          user_id: table.owner_id,
          table_id: table.id,
          table_name: table.name,
          rows: added,
        });
      } catch (err) {
        // A notification that fails must not undo rows that were added.
        log?.(`sync notification failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return {
      ok: true,
      value: {
        added_rows: added,
        new_versions: versions,
        removed_rows: removed,
        restored_rows: restored,
        runs,
      },
    };
  }

  async function runDue(onlyWorkspace?: string) {
    const due = await asWorker(pool, async (db) => {
      const { rows } = await db.query<{ workspace_id: string; table_id: string; owner_id: string }>(
        "select workspace_id, table_id, owner_id from work.rt_sync_due()",
      );
      return rows;
    });
    let passes = 0;
    for (const t of due.filter((d) => !onlyWorkspace || d.workspace_id === onlyWorkspace)) {
      // The owner's own view: their walls decide which files the table may add.
      const principal: Principal = {
        sessionId: "",
        userId: t.owner_id,
        workspaceId: t.workspace_id,
      };
      try {
        const result = await pass(principal, t.table_id, NO_CLIENT);
        if (result.ok) passes += 1;
      } catch (err) {
        log?.(
          `table sync failed for ${t.table_id}: ${err instanceof Error ? err.message : "unknown"}`,
        );
      }
    }
    return passes;
  }

  const tick = () => {
    running = runDue()
      .catch((err: unknown) =>
        log?.(`table sync failed: ${err instanceof Error ? err.message : String(err)}`),
      )
      .finally(() => {
        running = null;
      });
  };

  return {
    status(principal, tableId) {
      return asApp(pool, principal, async (db) => {
        const table = await loadTable(db, tableId);
        if (!table) return fail("NOT_FOUND");
        return { ok: true as const, value: await statusOf(db, table) };
      });
    },

    configure(principal, tableId, body, client) {
      return asApp(pool, principal, async (db) => {
        const table = await loadTable(db, tableId);
        if (!table) return fail("NOT_FOUND");
        if (body.mode !== "off" && table.source_kind !== "vault") {
          return fail("SYNC_UNAVAILABLE", "Only a table over a vault can sync.");
        }
        let folders: string[] | null = null;
        if (body.mode === "selected_folders") {
          folders = [...new Set(body.folder_ids ?? [])];
          const tree = await folderTree(db, table.vault_id ?? "", folders);
          if (tree.given !== folders.length) {
            return fail("SOURCE_MISMATCH", "A folder isn't in this table's vault.");
          }
        }
        const wasOn = table.sync_mode !== "off";
        const { rows } = await db.query<TableRow>(
          `update work.review_table
              set sync_mode = $2, sync_folder_ids = $3, sync_notify = $4, updated_at = now()
            where id = $1 returning *`,
          [tableId, body.mode, folders, body.mode === "off" ? false : body.notify],
        );
        if (body.mode !== "off" && !wasOn) {
          // Rows added by hand have no pinned version; from here on they stand for the one
          // the file has now, so a later version arrives as a new row.
          await db.query(
            `update work.rt_row r set version_id = v.id, version_no = v.version_no
               from work.rt_row s
               join lateral (select id, version_no from content.document_version
                              where document_id = s.document_ids[1]
                              order by version_no desc limit 1) v on true
              where s.id = r.id and r.table_id = $1 and r.version_id is null
                and cardinality(r.document_ids) = 1`,
            [tableId],
          );
        }
        await audit(
          db,
          principal,
          client,
          body.mode === "off"
            ? "table.sync.disabled"
            : wasOn
              ? "table.sync.updated"
              : "table.sync.enabled",
          tableId,
          { mode: body.mode, folders: folders?.length ?? 0, notify: body.notify },
        );
        return { ok: true as const, value: await statusOf(db, rows[0] as TableRow) };
      });
    },

    async run(principal, tableId, client) {
      const result = await pass(principal, tableId, client);
      if (result.ok) {
        await asApp(pool, principal, (db) =>
          audit(db, principal, client, "table.sync.requested", tableId, {
            rows: result.value.added_rows,
          }),
        );
      }
      return result;
    },

    runDue,

    start() {
      if (timer) return;
      tick();
      timer = setInterval(() => {
        if (!running) tick();
      }, INTERVAL_MS);
    },

    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      await running;
    },
  };
}
