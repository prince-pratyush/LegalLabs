import {
  type BulkCellsBody,
  type Cell,
  type CellCitation,
  type CellHistory,
  type ColumnProposal,
  CreateColumnBody,
  citationPath,
  dependentsOf,
  type Estimate,
  formatTyped,
  inRunOrder,
  type PatchCellBody,
  parseClassify,
  parseColumnOptions,
  parseTypedValue,
  type RowFilter,
  type RowSort,
  RT_LIMITS,
  type RunScope,
} from "@legallabs/contracts";
import { type Gateway, GatewayError } from "@legallabs/model-gateway";
import type pg from "pg";
import type { Client, Principal } from "../auth/auth.js";
import { asApp } from "../db.js";
import { modelsFor, NO_MODEL_MESSAGE } from "../matters/model-policy.js";
import { audit } from "./audit.js";
import { CELL_MAX_OUTPUT } from "./cell.js";
import { markDependentsStale } from "./dependencies.js";
import { RESTRICTED_SQL, rowsSql, UnknownColumn } from "./query.js";
import type { Runner, RunRequest } from "./runner.js";
import {
  type ColumnRow,
  type Db,
  type Failure,
  fail,
  loadColumns,
  loadTable,
  type Result,
  rowsJson,
  settingsOf,
  type TableRow,
  UUID,
} from "./tables.js";

interface CellRow {
  id: string;
  row_id: string;
  column_id: string;
  status: Cell["status"];
  error_code: Cell["error_code"];
  value_text: string | null;
  value_typed: Cell["value_typed"];
  reasoning: string | null;
  looked_at: Cell["looked_at"];
  citation_count: number;
  verified_citation_count: number;
  verified_by: string | null;
  verified_at: Date | null;
  locked: boolean;
  edited_by: string | null;
  flag_color: Cell["flag_color"];
  stale_since: Date | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: string | null;
  run_id: string | null;
  updated_at: Date;
}

/** Display text follows the table's settings, so a format change needs no re-run. */
export function cellJson(row: CellRow, table: TableRow, column?: ColumnRow): Cell {
  const typedText =
    row.value_typed && row.status === "done"
      ? formatTyped(row.value_typed, settingsOf(table), column?.options ?? {})
      : null;
  return {
    id: row.id,
    row_id: row.row_id,
    column_id: row.column_id,
    status: row.status,
    error_code: row.error_code,
    value_text: typedText || row.value_text,
    value_typed: row.value_typed,
    reasoning: row.reasoning,
    looked_at: row.looked_at,
    citation_count: row.citation_count,
    verified_citation_count: row.verified_citation_count,
    verified_by: row.verified_by,
    verified_at: row.verified_at?.toISOString() ?? null,
    locked: row.locked,
    edited_by: row.edited_by,
    flag_color: row.flag_color,
    stale_since: row.stale_since?.toISOString() ?? null,
    model: row.model,
    usage:
      row.input_tokens === null || row.output_tokens === null
        ? null
        : { input_tokens: row.input_tokens, output_tokens: row.output_tokens },
    cost_usd: row.cost_usd === null ? null : Number(row.cost_usd),
    run_id: row.run_id,
    updated_at: row.updated_at.toISOString(),
  };
}

export interface RowsPage {
  filter?: RowFilter;
  sort?: RowSort | null;
  limit: number;
  offset: number;
}

type BulkStep =
  | { kind: "rerun"; table: TableRow; columns: ColumnRow[]; byColumn: Map<string, string[]> }
  | { kind: "done"; affected: number; skipped: number };

interface Target {
  cellId: string;
  rowId: string;
}

/** Which cells a run touches, and what it skips and why (§4 rule 3). */
async function targets(
  db: Db,
  columnId: string,
  scope: RunScope,
  includeVerified: boolean,
): Promise<{ run: Target[]; locked: number; verified: number }> {
  const rowIds = typeof scope === "object" ? scope.row_ids : null;
  const { rows } = await db.query<{
    id: string;
    row_id: string;
    locked: boolean;
    verified: boolean;
  }>(
    `select c.id, c.row_id, c.locked or r.locked locked, c.verified_at is not null verified
       from work.rt_cell c join work.rt_row r on r.id = c.row_id and r.deleted_at is null
      where c.column_id = $1 and not r.source_removed
        -- Rows over a hidden file are left as they are, not run into errors that wipe them.
        and not ${RESTRICTED_SQL}
        and ($2::uuid[] is null or r.id = any($2::uuid[]))
        and ($3 <> 'pending' or c.status in ('pending', 'stale', 'blocked'))
      order by r.ordinal
      limit $4`,
    [
      columnId,
      rowIds,
      typeof scope === "string" ? scope : "rows",
      scope === "dry_run" ? RT_LIMITS.dryRunRows : null,
    ],
  );
  let locked = 0;
  let verified = 0;
  const run: Target[] = [];
  for (const row of rows) {
    if (row.locked) locked += 1;
    else if (row.verified && !includeVerified) verified += 1;
    else run.push({ cellId: row.id, rowId: row.row_id });
  }
  return { run, locked, verified };
}

const GENERATE_SYSTEM = `You design review tables for lawyers. Given what the reviewer wants, propose columns.
Reply with only a JSON object: {"columns": [{"label": "...", "type": "date|currency|number|verbatim|free|classify", "prompt": "...", "options": {...}}]}.
Labels are at most 80 characters. A prompt is a clear question answered from one document.
For classify, options is {"options": [{"id": "short_id", "label": "...", "color": "green"}], "allow_multiple": false, "allow_other": true} with 2 to 20 options; colors are red, orange, yellow, green, blue, purple, teal or gray.
For other types, options may be {}. Use date for dates, currency for money and number for counts or periods.`;

export function createCells(pool: pg.Pool, deps: { gateway: Gateway; runner: Runner }) {
  const { runner, gateway } = deps;
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

  async function cellOf(db: Db, tableId: string, cellId: string) {
    if (!UUID.test(cellId)) return null;
    const { rows } = await db.query<
      CellRow & { restricted: boolean; row_locked: boolean; source_removed: boolean }
    >(
      `select c.*, ${RESTRICTED_SQL} restricted, r.locked row_locked, r.source_removed
         from work.rt_cell c join work.rt_row r on r.id = c.row_id and r.deleted_at is null
         join work.rt_column k on k.id = c.column_id and k.deleted_at is null
        where c.id = $1 and c.table_id = $2
        for update of c`,
      [cellId, tableId],
    );
    const cell = rows[0];
    // A cell over a hidden document is not shown at all.
    return cell && !cell.restricted ? cell : null;
  }

  async function startRun(
    principal: Principal,
    client: Client,
    table: TableRow,
    column: ColumnRow,
    scope: RunScope,
    includeVerified: boolean,
    dryRun = scope === "dry_run",
    includeDependents = false,
    counted: RunRequest["counted"] = "column_run",
  ): Promise<
    Result<{
      run_id: string | null;
      cells: number;
      locked_skipped: number;
      verified_skipped: number;
      dependent_run_ids: string[];
    }>
  > {
    if (column.type === "manual")
      return fail("COLUMN_MANUAL", "Manual columns are typed in, not run.");
    if (column.state === "running")
      return fail("COLUMN_RUNNING", "This column is already running.");
    const { picked, columns } = await asApp(pool, principal, async (db) => ({
      picked: await targets(db, column.id, scope, includeVerified),
      columns: await loadColumns(db, table.id),
    }));
    const summary = {
      cells: picked.run.length,
      locked_skipped: picked.locked,
      verified_skipped: picked.verified,
      dependent_run_ids: [] as string[],
    };
    if (picked.run.length === 0) return { ok: true, value: { run_id: null, ...summary } };
    const models = await asApp(pool, principal, (db) =>
      modelsFor(db, gateway, { tables: [table.id], documents: [column.context_document_id] }),
    );
    if (!models.allows("read_extract")) return fail("MODEL_NOT_ALLOWED", NO_MODEL_MESSAGE);
    if (column.model && !models.permits(column.model)) {
      return fail("MODEL_NOT_ALLOWED", "This matter's model policy denies this column's model.");
    }
    const runId = await runner.start(
      principal,
      {
        tableId: table.id,
        columnId: column.id,
        column: {
          label: column.label,
          type: column.type as Exclude<typeof column.type, "manual">,
          prompt: column.prompt,
          options: column.options,
          language: column.language,
          model: column.model,
        },
        instructions: table.instructions,
        settings: settingsOf(table),
        targets: picked.run,
        scope,
        dryRun,
        counted,
        dependsOn: column.depends_on,
        contextDocumentId: column.context_document_id,
        labels: Object.fromEntries(columns.map((c) => [c.id, c.label])),
      },
      client,
    );
    const result = { ok: true as const, value: { run_id: runId, ...summary } };
    return includeDependents
      ? startDependents(
          principal,
          client,
          table,
          column,
          picked.run.map((t) => t.rowId),
          includeVerified,
          result,
          counted,
        )
      : result;
  }

  /**
   * Columns built on `column` follow it, each after the columns it uses, over the same rows.
   * Their cells wait for the runs ahead of them; locked cells are skipped, and so are
   * verified ones unless `includeVerified`.
   */
  async function startDependents<T extends { dependent_run_ids: string[] }>(
    principal: Principal,
    client: Client,
    table: TableRow,
    column: ColumnRow,
    rowIds: string[],
    includeVerified: boolean,
    after: { ok: true; value: T },
    counted: RunRequest["counted"] = "column_run",
  ): Promise<{ ok: true; value: T }> {
    const columns = await asApp(pool, principal, (db) => loadColumns(db, table.id));
    const edges = new Map(columns.map((c) => [c.id, c.depends_on]));
    const later = new Set(dependentsOf(edges, [column.id]));
    for (const next of inRunOrder(columns).filter((c) => later.has(c.id))) {
      if (next.type === "manual" || next.state === "running") continue;
      const started = await startRun(
        principal,
        client,
        table,
        next,
        { row_ids: rowIds },
        includeVerified,
        false,
        false,
        counted,
      );
      if (started.ok && started.value.run_id) {
        after.value.dependent_run_ids.push(started.value.run_id);
      }
    }
    return after;
  }

  async function estimateFor(
    db: Db,
    columns: ColumnRow[],
    scope: RunScope,
    includeVerified: boolean,
  ) {
    const models = gateway.models("read_extract");
    const window = gateway.contextTokens("read_extract");
    let cells = 0;
    let locked = 0;
    let verified = 0;
    let tokens = 0;
    let cost = 0;
    for (const column of columns) {
      if (column.type === "manual") continue;
      const picked = await targets(db, column.id, scope, includeVerified);
      locked += picked.locked;
      verified += picked.verified;
      if (picked.run.length === 0) continue;
      // Each cell reads at most what fits its window, so big documents cost no more than that.
      const { rows } = await db.query<{ tokens: string }>(
        `select coalesce(sum(least(t.chars / 3, $2 * 0.6)), 0) tokens
           from (select r.id, coalesce(sum(char_length(p.text)), 0) chars
                   from work.rt_row r
                   left join content.document_version v on v.document_id = any(r.document_ids)
                   left join content.page p on p.version_id = v.id
                  where r.id = any($1::uuid[]) group by r.id) t`,
        [picked.run.map((t) => t.rowId), window],
      );
      const input =
        Number(rows[0]?.tokens ?? 0) + picked.run.length * (1_000 + column.prompt.length / 3);
      const output = picked.run.length * CELL_MAX_OUTPUT * 0.4;
      const price = (models.find((m) => m.id === column.model) ?? models[0])?.price ?? {
        input: 0,
        output: 0,
      };
      cells += picked.run.length;
      tokens += input + output;
      cost += (input * price.input + output * price.output) / 1_000_000;
    }
    return {
      cells,
      locked_skipped: locked,
      verified_skipped: verified,
      est_tokens: Math.round(tokens),
      est_cost_usd: Math.round(cost * 10_000) / 10_000,
      // About ten seconds a cell on a small local model, two at a time.
      est_minutes: Math.round(((cells * 10) / 2 / 60) * 10) / 10,
    } satisfies Estimate;
  }

  return {
    rows(principal: Principal, tableId: string, page: RowsPage) {
      return withTable(principal, tableId, async (db, table) => {
        const columns = await loadColumns(db, tableId);
        let built: { sql: string; params: unknown[] };
        try {
          built = rowsSql({
            tableId,
            columns: new Map(columns.map((c) => [c.id, c.type])),
            filter: page.filter,
            sort: page.sort,
            limit: page.limit + 1,
            offset: page.offset,
          });
        } catch (err) {
          if (err instanceof UnknownColumn)
            return fail("INVALID_REQUEST", "That column isn't in this table.");
          throw err;
        }
        const { rows } = await db.query<{
          id: string;
          ordinal: number;
          document_ids: string[];
          flag_color: string | null;
          locked: boolean;
          restricted: boolean;
          source_removed: boolean;
          version_no: number | null;
          newer_version: boolean;
        }>(built.sql, built.params);
        const shown = rows.slice(0, page.limit);
        const visible = shown.filter((r) => !r.restricted).map((r) => r.id);
        const { rows: cells } = await db.query<CellRow>(
          `select c.* from work.rt_cell c join work.rt_column k on k.id = c.column_id and k.deleted_at is null
            where c.row_id = any($1::uuid[])`,
          [visible],
        );
        const byId = new Map(columns.map((c) => [c.id, c]));
        return {
          ok: true,
          value: {
            rows: await rowsJson(db, shown),
            cells: cells.map((c) => cellJson(c, table, byId.get(c.column_id))),
            next_cursor: rows.length > page.limit ? String(page.offset + page.limit) : null,
          },
        };
      });
    },

    get(principal: Principal, tableId: string, cellId: string) {
      return withTable(principal, tableId, async (db, table) => {
        const cell = await cellOf(db, tableId, cellId);
        if (!cell) return fail("NOT_FOUND");
        const column = (await loadColumns(db, tableId)).find((c) => c.id === cell.column_id);
        const { rows: cites } = await db.query<{
          id: string;
          ordinal: number;
          document_id: string;
          version_id: string;
          version_no: number;
          name: string;
          page_no: number | null;
          quote: string;
          char_from: number | null;
          char_to: number | null;
          status: CellCitation["status"];
          user_edited: boolean;
        }>(
          `select c.id, c.ordinal, d.id document_id, c.version_id, v.version_no, d.name, c.page_no,
                  c.quote, c.char_from, c.char_to, c.status, c.user_edited
             from work.rt_cell_citation c
             join content.document_version v on v.id = c.version_id
             join content.document d on d.id = v.document_id
            where c.cell_id = $1 order by c.ordinal`,
          [cellId],
        );
        const { rows: history } = await db.query<{
          at: Date;
          actor_id: string | null;
          field: CellHistory["field"];
          old: unknown;
          new: unknown;
        }>(
          "select at, actor_id, field, old, new from work.rt_cell_history where cell_id = $1 order by at desc, id desc limit 100",
          [cellId],
        );
        const citations: CellCitation[] = cites.map((c) => ({
          id: c.id,
          ordinal: c.ordinal,
          document_id: c.document_id,
          version_id: c.version_id,
          version_no: c.version_no,
          document_name: c.name,
          page: c.page_no,
          quote: c.quote,
          char_from: c.char_from,
          char_to: c.char_to,
          status: c.status,
          user_edited: c.user_edited,
          // Only a verified citation links to the viewer.
          open_url:
            c.status === "ok" && c.page_no !== null
              ? citationPath({
                  document_id: c.document_id,
                  version_no: c.version_no,
                  page: c.page_no,
                  ...(c.char_from !== null && c.char_to !== null
                    ? { char_from: c.char_from, char_to: c.char_to }
                    : {}),
                })
              : null,
        }));
        return {
          ok: true,
          value: {
            cell: cellJson(cell, table, column),
            citations,
            history: history.map((h) => ({ ...h, at: h.at.toISOString() })),
            comments: [],
          },
        };
      });
    },

    patch(
      principal: Principal,
      tableId: string,
      cellId: string,
      body: PatchCellBody,
      client: Client,
    ) {
      return withTable(principal, tableId, async (db, table) => {
        const cell = await cellOf(db, tableId, cellId);
        if (!cell) return fail("NOT_FOUND");
        // A locked cell takes no edits, verification or flags until it is unlocked, which may
        // be in the same request. A locked row is unlocked only through the row.
        const locked = cell.row_locked || (body.locked ?? cell.locked);
        const changesContent =
          body.value_text !== undefined ||
          body.verified !== undefined ||
          body.flag_color !== undefined;
        if (changesContent && locked) return fail("CELL_LOCKED", "This cell is locked.");
        const column = (await loadColumns(db, tableId)).find((c) => c.id === cell.column_id);
        if (!column) return fail("NOT_FOUND");
        const history: { field: string; old: unknown; new: unknown; action: string }[] = [];
        const sets: string[] = [];
        const params: unknown[] = [cellId];
        const set = (column: string, value: unknown) => {
          params.push(value);
          sets.push(`${column} = $${params.length}`);
        };
        if (body.value_text !== undefined) {
          const text = body.value_text;
          let typed: unknown = null;
          let shown = text;
          if (text !== null && column.type === "manual") {
            const options = (column.options.options as never[] | undefined) ?? [];
            const picked =
              column.options.input_type === "classify"
                ? parseClassify(text, { options, allowMultiple: true, allowOther: false })
                : null;
            typed = picked
              ? { kind: "manual", option_ids: picked.option_ids }
              : { kind: "manual", text };
          } else if (text !== null && column.type !== "manual") {
            const parsed = parseTypedValue(column.type, column.options, text, settingsOf(table));
            if (parsed.ok) {
              typed = parsed.value_typed;
              shown = parsed.value_text;
            }
          }
          set("value_text", shown);
          set("value_typed", typed === null ? null : JSON.stringify(typed));
          set("status", text === null ? "pending" : "done");
          set("error_code", null);
          set("edited_by", principal.userId);
          set("stale_since", null);
          history.push({
            field: "value",
            old: { value_text: cell.value_text, status: cell.status },
            new: { value_text: shown },
            action: "table.cell.edited",
          });
          // Citations stay, marked as no longer backing exactly what the cell says.
          await db.query("update work.rt_cell_citation set user_edited = true where cell_id = $1", [
            cellId,
          ]);
          // Answers that were built on the old value are out of date now.
          await markDependentsStale(db, principal, tableId, [cell.column_id], [cell.row_id]);
        }
        if (body.verified !== undefined && body.verified !== (cell.verified_at !== null)) {
          set("verified_by", body.verified ? principal.userId : null);
          sets.push(`verified_at = ${body.verified ? "now()" : "null"}`);
          history.push({
            field: "verified",
            old: cell.verified_at !== null,
            new: body.verified,
            action: body.verified ? "table.cell.verified" : "table.cell.unverified",
          });
        }
        if (body.locked !== undefined && body.locked !== cell.locked) {
          set("locked", body.locked);
          history.push({
            field: "locked",
            old: cell.locked,
            new: body.locked,
            action: body.locked ? "table.cell.locked" : "table.cell.unlocked",
          });
        }
        if (body.flag_color !== undefined && body.flag_color !== cell.flag_color) {
          set("flag_color", body.flag_color);
          history.push({
            field: "flag",
            old: cell.flag_color,
            new: body.flag_color,
            action: "table.cell.flagged",
          });
        }
        if (sets.length > 0) {
          await db.query(
            `update work.rt_cell set ${sets.join(", ")}, updated_at = now() where id = $1`,
            params,
          );
        }
        for (const h of history) {
          await db.query(
            `insert into work.rt_cell_history (workspace_id, table_id, cell_id, actor_id, field, old, new)
             values ($1, $2, $3, $4, $5, $6, $7)`,
            [
              principal.workspaceId,
              tableId,
              cellId,
              principal.userId,
              h.field,
              JSON.stringify(h.old),
              JSON.stringify(h.new),
            ],
          );
          await audit(db, principal, client, h.action, tableId, { cell_id: cellId });
        }
        const fresh = await cellOf(db, tableId, cellId);
        return { ok: true, value: { cell: cellJson(fresh as CellRow, table, column) } };
      });
    },

    bulk(principal: Principal, tableId: string, body: BulkCellsBody, client: Client) {
      return withTable<BulkStep>(principal, tableId, async (db, table) => {
        const ids = [...new Set(body.cell_ids)];
        if (body.op === "rerun") {
          const { rows } = await db.query<{ column_id: string; row_id: string }>(
            `select c.column_id, c.row_id from work.rt_cell c
               join work.rt_row r on r.id = c.row_id and r.deleted_at is null
              where c.id = any($1::uuid[]) and c.table_id = $2 and not c.locked and not r.locked
                and not r.source_removed and not ${RESTRICTED_SQL}`,
            [ids, tableId],
          );
          const columns = await loadColumns(db, tableId);
          const byColumn = new Map<string, string[]>();
          for (const r of rows)
            byColumn.set(r.column_id, [...(byColumn.get(r.column_id) ?? []), r.row_id]);
          if (rows.length > 0) {
            await audit(db, principal, client, "table.cell.rerun", tableId, {
              cells: rows.length,
              bulk: true,
            });
          }
          return { ok: true, value: { kind: "rerun", table, columns, byColumn } };
        }
        const [field, value, action] = ((): [string, string, string] => {
          switch (body.op) {
            case "verify":
              return [
                "verified",
                "verified_by = p.actor, verified_at = now()",
                "table.cell.verified",
              ];
            case "unverify":
              return [
                "verified",
                "verified_by = null, verified_at = null",
                "table.cell.unverified",
              ];
            case "lock":
              return ["locked", "locked = true", "table.cell.locked"];
            case "unlock":
              return ["locked", "locked = false", "table.cell.unlocked"];
            case "flag":
              return ["flag", "flag_color = p.flag", "table.cell.flagged"];
            default:
              return ["flag", "flag_color = null", "table.cell.flagged"];
          }
        })();
        // Lock and unlock always apply; anything else skips locked cells and locked rows.
        // The history keeps old and new; `o` is the snapshot from before this statement.
        const state = (alias: string) =>
          field === "verified"
            ? `to_jsonb(${alias}.verified_at is not null)`
            : field === "locked"
              ? `to_jsonb(${alias}.locked)`
              : `to_jsonb(${alias}.flag_color)`;
        const { rows } = await db.query<{ id: string }>(
          // Every parameter is typed here, as some ops don't use them all.
          `with p as (select $3::uuid actor, $4::text flag),
           changed as (
             update work.rt_cell c set ${value}, updated_at = now()
               from work.rt_row r, p, work.rt_cell o
              where c.id = any($1::uuid[]) and c.table_id = $2 and r.id = c.row_id
                and r.deleted_at is null and o.id = c.id
                and not ${RESTRICTED_SQL}
                and ($5 or not (c.locked or r.locked))
             returning c.id, ${state("o")} before, ${state("c")} after
           ), logged as (
             insert into work.rt_cell_history
               (workspace_id, table_id, cell_id, actor_id, field, old, new)
             select $6, $2, id, $3, $7, before, after from changed
           )
           select id from changed`,
          [
            ids,
            tableId,
            principal.userId,
            body.flag_color ?? null,
            body.op === "lock" || body.op === "unlock",
            principal.workspaceId,
            field,
          ],
        );
        if (rows.length > 0) {
          await audit(db, principal, client, action, tableId, { cells: rows.length, bulk: true });
        }
        return {
          ok: true,
          value: { kind: "done", affected: rows.length, skipped: ids.length - rows.length },
        };
      }).then(
        async (
          result,
        ): Promise<Result<{ affected: number; skipped: number; run_ids: string[] }>> => {
          if (!result.ok) return result;
          if (result.value.kind === "done") {
            return {
              ok: true,
              value: {
                affected: result.value.affected,
                skipped: result.value.skipped,
                run_ids: [],
              },
            };
          }
          const { table, columns, byColumn } = result.value;
          const runIds: string[] = [];
          let affected = 0;
          let denied: Failure | undefined;
          for (const [columnId, rowIds] of byColumn) {
            const column = columns.find((c) => c.id === columnId);
            if (!column) continue;
            const started = await startRun(
              principal,
              client,
              table,
              column,
              { row_ids: rowIds },
              true,
              false,
              false,
              "cell_rerun",
            );
            if (started.ok && started.value.run_id) {
              runIds.push(started.value.run_id);
              affected += started.value.cells;
            }
            if (!started.ok && started.code === "MODEL_NOT_ALLOWED") denied = started;
          }
          if (denied && runIds.length === 0) return denied;
          return {
            ok: true,
            value: { affected, skipped: body.cell_ids.length - affected, run_ids: runIds },
          };
        },
      );
    },

    async rerun(
      principal: Principal,
      tableId: string,
      cellId: string,
      client: Client,
      options: { includeDependents?: boolean; includeVerified?: boolean } = {},
    ) {
      const found = await withTable(principal, tableId, async (db, table) => {
        const cell = await cellOf(db, tableId, cellId);
        if (!cell) return fail("NOT_FOUND");
        if (cell.locked || cell.row_locked) return fail("CELL_LOCKED", "This cell is locked.");
        if (cell.source_removed) {
          return fail("SOURCE_REMOVED", "The file has left the vault, so this can't be re-run.");
        }
        const column = (await loadColumns(db, tableId)).find((c) => c.id === cell.column_id);
        if (!column) return fail("NOT_FOUND");
        await audit(db, principal, client, "table.cell.rerun", tableId, {
          cell_id: cellId,
          dependents: options.includeDependents === true,
        });
        return { ok: true, value: { table, column, rowId: cell.row_id } };
      });
      if (!found.ok) return found;
      const { table, column, rowId } = found.value;
      // The cell itself always runs, verified or not; the flag is for what follows it.
      const started = await startRun(
        principal,
        client,
        table,
        column,
        { row_ids: [rowId] },
        true,
        false,
        false,
        "cell_rerun",
      );
      if (!started.ok || !options.includeDependents) return started;
      return startDependents(
        principal,
        client,
        table,
        column,
        [rowId],
        options.includeVerified === true,
        started,
        "cell_rerun",
      );
    },

    /** Starts a column on some rows, for sync: cells in those rows only, nothing verified. */
    async runRows(
      principal: Principal,
      tableId: string,
      columnId: string,
      rowIds: string[],
      client: Client,
    ) {
      const found = await withTable(principal, tableId, async (db, table) => {
        const column = (await loadColumns(db, tableId)).find((c) => c.id === columnId);
        return column ? { ok: true as const, value: { table, column } } : fail("NOT_FOUND");
      });
      if (!found.ok) return found;
      return startRun(
        principal,
        client,
        found.value.table,
        found.value.column,
        { row_ids: rowIds },
        false,
        false,
        false,
        "sync_run",
      );
    },

    async runColumn(
      principal: Principal,
      tableId: string,
      columnId: string,
      scope: RunScope,
      includeVerified: boolean,
      client: Client,
      view: {
        sort?: RowSort | undefined;
        filter?: RowFilter | undefined;
        includeDependents?: boolean;
      } = {},
    ) {
      const found = await withTable(principal, tableId, async (db, table) => {
        const columns = await loadColumns(db, tableId);
        const column = columns.find((c) => c.id === columnId);
        if (!column) return fail("NOT_FOUND");
        let effective = scope;
        if (scope === "dry_run" && (view.sort || view.filter)) {
          // The first rows the user sees, in their order and filter (spec §3.10).
          let built: { sql: string; params: unknown[] };
          try {
            built = rowsSql({
              tableId,
              columns: new Map(columns.map((c) => [c.id, c.type])),
              filter: view.filter,
              sort: view.sort,
              limit: RT_LIMITS.dryRunRows,
            });
          } catch (err) {
            if (err instanceof UnknownColumn) return fail("INVALID_REQUEST");
            throw err;
          }
          const { rows } = await db.query<{ id: string; restricted: boolean }>(
            built.sql,
            built.params,
          );
          const ids = rows.filter((r) => !r.restricted).map((r) => r.id);
          if (ids.length === 0) return fail("INVALID_REQUEST", "No rows match this view.");
          effective = { row_ids: ids };
        }
        // Estimated before the cells are queued, so it counts what this run will do.
        const estimate = await estimateFor(db, [column], effective, includeVerified);
        return { ok: true as const, value: { table, column, estimate, effective } };
      });
      if (!found.ok) return found;
      const { table, column, estimate, effective } = found.value;
      const started = await startRun(
        principal,
        client,
        table,
        column,
        effective,
        includeVerified,
        scope === "dry_run",
        view.includeDependents === true,
      );
      if (!started.ok) return started;
      return { ok: true as const, value: { ...started.value, estimate } };
    },

    async runTable(
      principal: Principal,
      tableId: string,
      scope: "pending" | "dry_run",
      client: Client,
    ) {
      const found = await withTable(principal, tableId, async (db, table) => ({
        ok: true as const,
        value: { table, columns: await loadColumns(db, tableId) },
      }));
      if (!found.ok) return found;
      const runIds: string[] = [];
      let denied: Failure | undefined;
      // Columns others use go first, so the ones that wait on them find their cells queued.
      for (const column of inRunOrder(found.value.columns)) {
        if (column.type === "manual" || column.state === "running") continue;
        // A dry run of the whole table tries out the columns that have never run.
        if (scope === "dry_run" && column.state !== "pending") continue;
        const started = await startRun(principal, client, found.value.table, column, scope, false);
        if (started.ok && started.value.run_id) runIds.push(started.value.run_id);
        if (!started.ok && started.code === "MODEL_NOT_ALLOWED") denied = started;
      }
      // Refused columns are said so, unless others did start.
      if (denied && runIds.length === 0) return denied;
      return { ok: true as const, value: { run_ids: runIds } };
    },

    estimate(
      principal: Principal,
      tableId: string,
      columnIds: readonly string[],
      scope: RunScope,
      includeVerified: boolean,
    ) {
      return withTable(principal, tableId, async (db) => {
        const columns = (await loadColumns(db, tableId)).filter((c) => columnIds.includes(c.id));
        if (columns.length !== new Set(columnIds).size)
          return fail("INVALID_REQUEST", "A column isn't in this table.");
        return { ok: true, value: await estimateFor(db, columns, scope, includeVerified) };
      });
    },

    /** Column Builder: proposals that fail the column schema are dropped, never shown. */
    async generate(principal: Principal, tableId: string, description: string, max: number) {
      const found = await withTable(principal, tableId, async (db) => {
        const { rows } = await db.query<{ name: string }>(
          `select d.name from work.rt_row r join content.document d on d.id = r.document_ids[1]
            where r.table_id = $1 and r.deleted_at is null order by r.ordinal limit 20`,
          [tableId],
        );
        const models = await modelsFor(db, gateway, { tables: [tableId] });
        return { ok: true as const, value: { names: rows.map((r) => r.name), models } };
      });
      if (!found.ok) return found;
      const { names, models } = found.value;
      if (!models.allows("draft_edit")) return fail("MODEL_NOT_ALLOWED", NO_MODEL_MESSAGE);
      let output: string;
      try {
        const result = await gateway.call({
          task_class: "draft_edit",
          messages: [
            { role: "system", content: GENERATE_SYSTEM },
            {
              role: "user",
              content: `The reviewer wants: ${description}\n\nSome files in the table:\n${names
                .map((n) => `- ${n.replace(/[\p{Cc}\p{Cf}]+/gu, " ").slice(0, 200)}`)
                .join("\n")}\n\nPropose up to ${max} columns.`,
            },
          ],
          budget: { max_output: 3_000, max_cost_usd: 1 },
          routing: { workspace: principal.workspaceId, user: principal.userId },
          trace: tableId,
          ...(models.exclude.length ? { exclude: models.exclude } : {}),
        });
        output = result.output;
      } catch (err) {
        if (err instanceof GatewayError)
          return err.refused
            ? fail("MODEL_NOT_ALLOWED", err.message)
            : fail("MODEL_UNAVAILABLE", "No model could propose columns just now.");
        throw err;
      }
      const proposals: ColumnProposal[] = [];
      const start = output.indexOf("{");
      const end = output.lastIndexOf("}");
      let raw: unknown[] = [];
      try {
        const parsed = JSON.parse(output.slice(start, end + 1)) as { columns?: unknown[] };
        raw = Array.isArray(parsed.columns) ? parsed.columns : [];
      } catch {
        raw = [];
      }
      let dropped = 0;
      for (const item of raw) {
        const checked = CreateColumnBody.safeParse(item);
        if (!checked.success || checked.data.type === "manual") {
          dropped += 1;
          continue;
        }
        if (proposals.length >= max) break;
        const options = parseColumnOptions(checked.data.type, checked.data.options);
        if (!options.success) continue;
        proposals.push({
          label: checked.data.label,
          type: checked.data.type,
          prompt: checked.data.prompt,
          options: options.data as Record<string, unknown>,
        });
      }
      return { ok: true as const, value: { proposals, dropped, run_id: null } };
    },
  };
}

export type Cells = ReturnType<typeof createCells>;
