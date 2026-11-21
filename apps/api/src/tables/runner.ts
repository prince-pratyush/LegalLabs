import { RT_LIMITS, type Settings } from "@legallabs/contracts";
import type { Gateway } from "@legallabs/model-gateway";
import type pg from "pg";
import { type Client, type Principal, uaHash } from "../auth/auth.js";
import { asApp } from "../db.js";
import type { Documents } from "../documents/documents.js";
import type { RunLog } from "../runs/log.js";
import {
  type CellColumn,
  type CellDocument,
  type CellOutcome,
  type CellSources,
  type PageText,
  runCell,
} from "./cell.js";

type Db = pg.PoolClient;

export interface RunTarget {
  cellId: string;
  rowId: string;
}

export interface RunRequest {
  tableId: string;
  columnId: string;
  column: CellColumn;
  instructions: string;
  settings: Settings;
  targets: readonly RunTarget[];
  scope: unknown;
  dryRun: boolean;
}

export interface Runner {
  /** Queues the cells and returns the run id; the cells run in the background. */
  start(principal: Principal, request: RunRequest, client: Client): Promise<string>;
  /** Stops queued cells; running ones finish. False if the run isn't the caller's table run. */
  cancel(principal: Principal, runId: string, client: Client): Promise<boolean>;
  /** Waits for every run in this process, for tests and shutdown. */
  idle(): Promise<void>;
}

export interface RunnerOptions {
  gateway: Gateway;
  documents: Documents;
  log: RunLog;
  /** Cells in flight across every run in this process. */
  cellsInFlight?: number;
}

/** A counting semaphore: waiters are served in order. */
function semaphore(size: number) {
  let free = size;
  const waiting: (() => void)[] = [];
  return {
    async take() {
      if (free > 0) {
        free -= 1;
        return;
      }
      await new Promise<void>((resolve) => waiting.push(resolve));
    },
    give() {
      const next = waiting.shift();
      if (next) next();
      else free += 1;
    },
  };
}

const audit = (
  db: Db,
  principal: Principal,
  client: Client,
  action: string,
  tableId: string,
  details: object,
) =>
  // Ids and counts only: values and prompts stay out of the audit log.
  db.query("select admin.append_audit_event($1, 'user', $2, 'table', $3, $4, $5, $6)", [
    action,
    principal.userId,
    tableId,
    JSON.stringify(details),
    client.ip,
    uaHash(client),
  ]);

export async function columnProgress(db: Db, columnId: string) {
  const { rows } = await db.query<{
    done: number;
    total: number;
    null: number;
    error: number;
    cost_usd: string;
  }>(
    `select count(*) filter (where c.status = 'done')::int done, count(*)::int total,
            count(*) filter (where c.status = 'null')::int "null",
            count(*) filter (where c.status = 'error')::int error,
            coalesce(sum(c.cost_usd), 0) cost_usd
       from work.rt_cell c join work.rt_row r on r.id = c.row_id and r.deleted_at is null
      where c.column_id = $1`,
    [columnId],
  );
  const row = rows[0];
  return {
    done: row?.done ?? 0,
    total: row?.total ?? 0,
    null: row?.null ?? 0,
    error: row?.error ?? 0,
    cost_usd: Number(row?.cost_usd ?? 0),
  };
}

/** Totals kept on the table so lists needn't count cells. */
export async function refreshStats(db: Db, tableId: string) {
  await db.query(
    `update work.review_table t set stats = s.stats, updated_at = now()
       from (select jsonb_build_object(
               'cells_done', count(*) filter (where c.status = 'done'),
               'cells_null', count(*) filter (where c.status = 'null'),
               'cells_error', count(*) filter (where c.status = 'error'),
               'cost_usd', coalesce(sum(c.cost_usd), 0),
               'citations', coalesce(sum(c.citation_count), 0),
               'verified_citations', coalesce(sum(c.verified_citation_count), 0)) stats
               from work.rt_cell c
               join work.rt_row r on r.id = c.row_id and r.deleted_at is null
               join work.rt_column k on k.id = c.column_id and k.deleted_at is null
              where c.table_id = $1) s
      where t.id = $1`,
    [tableId],
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createRunner(pool: pg.Pool, options: RunnerOptions): Runner {
  const { gateway, documents, log } = options;
  const inFlight = semaphore(Math.max(1, options.cellsInFlight ?? 2));
  // Per table, at most three columns run at once; a fourth waits its turn.
  const tables = new Map<string, ReturnType<typeof semaphore>>();
  const slotFor = (tableId: string) => {
    let slot = tables.get(tableId);
    if (!slot) {
      slot = semaphore(RT_LIMITS.runningColumns);
      tables.set(tableId, slot);
    }
    return slot;
  };
  const cancelled = new Set<string>();
  const active = new Set<string>();
  const work = new Set<Promise<void>>();

  function sources(principal: Principal): CellSources {
    return {
      size: (versionIds) =>
        asApp(pool, principal, async (db) => {
          const { rows } = await db.query<{ n: string }>(
            `select coalesce(sum(char_length(text)), 0) n from content.page
              where version_id = any($1::uuid[])`,
            [versionIds],
          );
          return Number(rows[0]?.n ?? 0);
        }),
      pages: (versionIds) =>
        asApp(pool, principal, async (db) => {
          const { rows } = await db.query<{ version_id: string; page_no: number; text: string }>(
            `select version_id, page_no, text from content.page
              where version_id = any($1::uuid[]) order by array_position($1::uuid[], version_id), page_no`,
            [versionIds],
          );
          return rows.map(
            (r): PageText => ({ versionId: r.version_id, page: r.page_no, text: r.text }),
          );
        }),
      search: async (query, documentIds, versionIds) =>
        (
          await documents.search(principal, query, {
            documentIds,
            versionIds,
            match: "any",
            limit: 24,
          })
        ).map((p) => ({ versionId: p.documentVersionId, page: p.page, text: p.text })),
      page: async (versionId, page) =>
        (await documents.page(principal, versionId, page))?.text ?? null,
    };
  }

  async function rowDocuments(principal: Principal, rowId: string) {
    return asApp(pool, principal, async (db) => {
      const { rows } = await db.query<{ document_ids: string[] }>(
        "select document_ids from work.rt_row where id = $1",
        [rowId],
      );
      const ids = rows[0]?.document_ids ?? [];
      const found = await db.query<{
        id: string;
        version_id: string;
        version_no: number;
        name: string;
        page_count: number;
        status: string;
      }>(
        `select d.id, v.id version_id, v.version_no, d.name, v.page_count,
                coalesce(j.status, 'indexed') status
           from content.document d
           join lateral (select id, version_no, page_count from content.document_version
                          where document_id = d.id order by version_no desc limit 1) v on true
           left join content.ingest_job j on j.version_id = v.id
          where d.id = any($1::uuid[])
          order by array_position($1::uuid[], d.id)`,
        [ids],
      );
      return { expected: ids.length, documents: found.rows };
    });
  }

  async function execute(
    principal: Principal,
    runId: string,
    request: RunRequest,
    target: RunTarget,
  ): Promise<number> {
    const emit = (outcome: {
      status: string;
      errorCode?: string | null;
      citations?: number;
      verified?: number;
      cost?: number | null;
    }) =>
      log.append(principal, runId, {
        type: "cell.updated",
        table_id: request.tableId,
        cell_id: target.cellId,
        row_id: target.rowId,
        column_id: request.columnId,
        status: outcome.status as "running",
        error_code: (outcome.errorCode ?? null) as null,
        citation_count: outcome.citations ?? 0,
        verified_citation_count: outcome.verified ?? 0,
        cost_usd: outcome.cost ?? null,
      });

    const claimed = await asApp(pool, principal, (db) =>
      db.query<{ value_text: string | null; status: string }>(
        `update work.rt_cell set status = 'running', updated_at = now()
          where id = $1 and run_id = $2 and status = 'queued' and not locked
          returning value_text, status`,
        [target.cellId, runId],
      ),
    );
    if (claimed.rowCount === 0) return 0;
    const before = claimed.rows[0]?.value_text ?? null;
    await emit({ status: "running" });

    const row = await rowDocuments(principal, target.rowId);
    let outcome: CellOutcome;
    const failed = (code: "ACCESS_DENIED" | "DOC_NOT_READY"): CellOutcome => ({
      status: "error",
      errorCode: code,
      valueText: null,
      valueTyped: null,
      reasoning: null,
      lookedAt: null,
      citations: [],
      verbatimCitation: null,
      model: null,
      usage: null,
      costUsd: null,
    });
    if (row.documents.length < row.expected) {
      // A cell is never generated for a document the runner cannot read.
      outcome = failed("ACCESS_DENIED");
    } else if (row.documents.some((d) => d.status !== "indexed")) {
      outcome = failed("DOC_NOT_READY");
    } else {
      const docs: CellDocument[] = row.documents.map((d) => ({
        id: d.id,
        versionId: d.version_id,
        versionNo: d.version_no,
        name: d.name,
        pageCount: d.page_count,
      }));
      try {
        outcome = await runCell(
          { gateway, sources: sources(principal) },
          {
            column: request.column,
            instructions: request.instructions,
            settings: request.settings,
            documents: docs,
            workspaceId: principal.workspaceId,
            trace: runId,
          },
        );
      } catch (err) {
        console.error(
          `cell ${target.cellId} failed: ${err instanceof Error ? err.name : "unknown"}`,
        );
        outcome = { ...failed("ACCESS_DENIED"), errorCode: "MODEL_ERROR" };
      }
    }

    const verified = outcome.citations.filter((c) => c.status === "ok").length;
    const saved = await asApp(pool, principal, async (db) => {
      const updated = await db.query(
        `update work.rt_cell
            set status = $3, error_code = $4, value_text = $5, value_typed = $6, reasoning = $7,
                looked_at = $8, citation_count = $9, verified_citation_count = $10, model = $11,
                input_tokens = $12, output_tokens = $13, cost_usd = $14, stale_since = null,
                verified_by = null, verified_at = null, edited_by = null, updated_at = now()
          where id = $1 and run_id = $2 and status = 'running' and not locked`,
        [
          target.cellId,
          runId,
          outcome.status,
          outcome.errorCode,
          outcome.valueText,
          outcome.valueTyped ? JSON.stringify(outcome.valueTyped) : null,
          outcome.reasoning,
          outcome.lookedAt ? JSON.stringify(outcome.lookedAt) : null,
          outcome.citations.length,
          verified,
          outcome.model,
          outcome.usage?.input_tokens ?? null,
          outcome.usage?.output_tokens ?? null,
          outcome.costUsd,
        ],
      );
      if (updated.rowCount === 0) return false;
      await db.query("delete from work.rt_cell_citation where cell_id = $1", [target.cellId]);
      if (outcome.citations.length > 0) {
        const pick = <T>(f: (c: CellOutcome["citations"][number]) => T) => outcome.citations.map(f);
        const { rows } = await db.query<{ id: string; ordinal: number }>(
          `insert into work.rt_cell_citation
             (workspace_id, table_id, cell_id, ordinal, version_id, page_no, quote, char_from,
              char_to, status)
           select $1, $2, $3, * from unnest($4::int[], $5::uuid[], $6::int[], $7::text[],
                                            $8::int[], $9::int[], $10::text[])
           returning id, ordinal`,
          [
            principal.workspaceId,
            request.tableId,
            target.cellId,
            outcome.citations.map((_, i) => i + 1),
            pick((c) => c.versionId),
            pick((c) => c.page),
            pick((c) => c.quote),
            pick((c) => c.from),
            pick((c) => c.to),
            pick((c) => c.status),
          ],
        );
        if (outcome.verbatimCitation !== null && outcome.valueTyped?.kind === "verbatim") {
          const id = rows.find((r) => r.ordinal === (outcome.verbatimCitation ?? 0) + 1)?.id;
          await db.query(
            `update work.rt_cell set value_typed = jsonb_set(value_typed, '{citation_id}', to_jsonb($2::text))
              where id = $1`,
            [target.cellId, id ?? null],
          );
        }
      }
      await db.query(
        `insert into work.rt_cell_history (workspace_id, table_id, cell_id, actor_id, field, old, new)
         values ($1, $2, $3, $4, 'run', $5, $6)`,
        [
          principal.workspaceId,
          request.tableId,
          target.cellId,
          principal.userId,
          JSON.stringify({ value_text: before }),
          JSON.stringify({
            run_id: runId,
            status: outcome.status,
            error_code: outcome.errorCode,
            value_text: outcome.valueText,
          }),
        ],
      );
      return true;
    });
    if (!saved) return 0;
    await emit({
      status: outcome.status,
      errorCode: outcome.errorCode,
      citations: outcome.citations.length,
      verified,
      cost: outcome.costUsd,
    });
    const progress = await asApp(pool, principal, (db) => columnProgress(db, request.columnId));
    await log.append(principal, runId, {
      type: "column.progress",
      table_id: request.tableId,
      column_id: request.columnId,
      ...progress,
    });
    return outcome.costUsd ?? 0;
  }

  async function drive(principal: Principal, runId: string, request: RunRequest, client: Client) {
    const slot = slotFor(request.tableId);
    let cost = 0;
    let cells = 0;
    try {
      await slot.take();
      try {
        if (!cancelled.has(runId)) {
          await asApp(pool, principal, (db) =>
            db.query(
              "update work.run set status = 'running', updated_at = now() where id = $1 and status = 'planned'",
              [runId],
            ),
          );
          await log.append(principal, runId, { type: "status", status: "running" });
          const queue = [...request.targets];
          const worker = async () => {
            for (let target = queue.shift(); target; target = queue.shift()) {
              if (cancelled.has(runId)) return;
              await inFlight.take();
              try {
                if (cancelled.has(runId)) return;
                cost += await execute(principal, runId, request, target);
                cells += 1;
              } catch (err) {
                console.error(`cell ${target.cellId}: ${err instanceof Error ? err.message : err}`);
              } finally {
                inFlight.give();
              }
            }
          };
          await Promise.all(
            Array.from({ length: Math.min(request.targets.length, 4) }, () => worker()),
          );
        }
      } finally {
        slot.give();
      }
      const stopped = cancelled.has(runId);
      const progress = await asApp(pool, principal, async (db) => {
        await db.query(
          `update work.run set status = $2, cost_usd = $3, updated_at = now()
            where id = $1 and status in ('planned', 'running')`,
          [runId, stopped ? "cancelled" : "done", cost],
        );
        await db.query(
          `update work.rt_column set state = $3, updated_at = now() where id = $1 and run_id = $2`,
          [request.columnId, runId, stopped ? "stopped" : request.dryRun ? "partial" : "done"],
        );
        await refreshStats(db, request.tableId);
        await audit(
          db,
          principal,
          client,
          stopped ? "run.cancelled" : "run.completed",
          request.tableId,
          {
            run_id: runId,
            column_id: request.columnId,
            cells,
            cost_usd: cost,
          },
        );
        return columnProgress(db, request.columnId);
      });
      await log.append(principal, runId, {
        type: "column.progress",
        table_id: request.tableId,
        column_id: request.columnId,
        ...progress,
      });
      await log.append(principal, runId, {
        type: "status",
        status: stopped ? "cancelled" : "done",
      });
    } catch (err) {
      console.error(`table run ${runId} failed: ${err instanceof Error ? err.message : "unknown"}`);
      await asApp(pool, principal, async (db) => {
        await db.query(
          "update work.run set status = 'failed', updated_at = now() where id = $1 and status in ('planned', 'running')",
          [runId],
        );
        await db.query(
          `update work.rt_cell set status = case when value_text is null then 'pending' else 'stale' end,
                  updated_at = now()
            where run_id = $1 and status in ('queued', 'running')`,
          [runId],
        );
        await db.query(
          "update work.rt_column set state = 'stopped' where id = $1 and run_id = $2",
          [request.columnId, runId],
        );
      }).catch(() => {});
      await log.append(principal, runId, { type: "status", status: "failed" }).catch(() => {});
    } finally {
      cancelled.delete(runId);
      active.delete(runId);
      log.release(runId);
    }
  }

  return {
    async start(principal, request, client) {
      const runId = await asApp(pool, principal, async (db) => {
        const { rows } = await db.query<{ id: string }>(
          `insert into work.run (workspace_id, owner_id, kind, status, table_id, column_id, scope)
           values ($1, $2, 'rt_column', 'planned', $3, $4, $5) returning id`,
          [
            principal.workspaceId,
            principal.userId,
            request.tableId,
            request.columnId,
            JSON.stringify(request.scope),
          ],
        );
        const id = rows[0]?.id;
        if (!id) throw new Error("insert returned no run");
        await db.query(
          `update work.rt_column set state = 'running', run_id = $2, dry_run = $3, updated_at = now()
            where id = $1`,
          [request.columnId, id, request.dryRun],
        );
        await db.query(
          `update work.rt_cell set status = 'queued', error_code = null, run_id = $2, updated_at = now()
            where id = any($1::uuid[]) and not locked`,
          [request.targets.map((t) => t.cellId), id],
        );
        await audit(db, principal, client, "table.column.run", request.tableId, {
          column_id: request.columnId,
          scope: request.scope,
          cells: request.targets.length,
          run_id: id,
        });
        return id;
      });
      active.add(runId);
      await log.append(principal, runId, { type: "status", status: "planned" });
      const job = drive(principal, runId, request, client);
      work.add(job);
      void job.finally(() => work.delete(job));
      return runId;
    },

    async cancel(principal, runId, client) {
      // Not an id: not a table run, so the caller can fall through to thread runs.
      if (!UUID.test(runId)) return false;
      const found = await asApp(pool, principal, async (db) => {
        const { rows } = await db.query<{ table_id: string; status: string }>(
          `select table_id, status from work.run
            where id = $1 and kind = 'rt_column' and owner_id = $2`,
          [runId, principal.userId],
        );
        const run = rows[0];
        if (!run) return null;
        if (run.status === "planned" || run.status === "running") {
          // Queued cells go back to waiting at once; running ones finish and save.
          await db.query(
            `update work.rt_cell
                set status = case when value_text is null then 'pending' else 'stale' end,
                    stale_since = case when value_text is null then null else now() end,
                    updated_at = now()
              where run_id = $1 and status = 'queued'`,
            [runId],
          );
          if (!active.has(runId)) {
            await db.query(
              "update work.run set status = 'cancelled', updated_at = now() where id = $1",
              [runId],
            );
          }
          await audit(db, principal, client, "table.run.cancel", run.table_id, { run_id: runId });
        }
        return run;
      });
      if (!found) return false;
      if (active.has(runId)) cancelled.add(runId);
      return true;
    },

    async idle() {
      while (work.size > 0) await Promise.all([...work]);
    },
  };
}
