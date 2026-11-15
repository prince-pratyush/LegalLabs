import type { CellCondition, ColumnType, RowFilter, RowSort } from "@legallabs/contracts";

// Filters and typed sort for the rows page, built as SQL so a big table never loads in memory.
// Every (row, column) pair has a cell, so a condition is one EXISTS on that pair.

/** A row is restricted when a wall or the bin hides any of its documents from the caller. */
export const RESTRICTED_SQL = `exists (
  select 1 from unnest(r.document_ids) x(id)
   where not exists (select 1 from content.document d where d.id = x.id))`;

export class UnknownColumn extends Error {}

export interface RowQuery {
  tableId: string;
  /** Live columns of the table and their types. */
  columns: ReadonlyMap<string, ColumnType>;
  filter?: RowFilter | undefined;
  sort?: RowSort | null | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

function condition(c: CellCondition, param: (value: unknown) => string): string {
  const parts = ["c.row_id = r.id", `c.column_id = ${param(c.column_id)}`];
  if (c.status) parts.push(`c.status = any(${param(c.status)}::text[])`);
  if (c.flag) parts.push(`c.flag_color = any(${param(c.flag)}::text[])`);
  if (c.flagged !== undefined) parts.push(`c.flag_color is ${c.flagged ? "not " : ""}null`);
  if (c.verified !== undefined) parts.push(`c.verified_at is ${c.verified ? "not " : ""}null`);
  if (c.locked !== undefined) parts.push(`c.locked = ${param(c.locked)}`);
  if (c.contains !== undefined) {
    // Matched literally: % and _ in the text are not wildcards.
    const escaped = c.contains.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    parts.push(`c.value_text ilike ${param(`%${escaped}%`)}`);
  }
  if (c.option_ids) {
    parts.push(
      `c.value_typed->'option_ids' ?| ${param(c.option_ids)}::text[] and c.status = 'done'`,
    );
  }
  return `exists (select 1 from work.rt_cell c where ${parts.join(" and ")})`;
}

/** Only finished, visible values sort; the rest, hidden rows included, sort last either way. */
function sortExpression(type: ColumnType): string {
  const value = (() => {
    switch (type) {
      case "date":
        return "s.value_typed->>'iso'";
      case "currency":
        return "(s.value_typed->>'amount')::numeric";
      case "number":
        return "(s.value_typed->>'value')::numeric";
      default:
        return "lower(s.value_text)";
    }
  })();
  return `case when s.status = 'done' and not ${RESTRICTED_SQL} then ${value} end`;
}

/** The rows page as SQL and parameters. Throws UnknownColumn for a column not in the table. */
export function rowsSql(query: RowQuery): { sql: string; params: unknown[] } {
  const params: unknown[] = [query.tableId];
  const param = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  const known = (id: string) => {
    if (!query.columns.has(id)) throw new UnknownColumn(id);
    return id;
  };
  const conditions = query.filter?.conditions ?? [];
  for (const c of conditions) known(c.column_id);
  const where = [
    "r.table_id = $1",
    "r.deleted_at is null",
    ...conditions.map((c) => condition(c, param)),
    // Hidden values must not be findable by filtering on them.
    ...(conditions.length > 0 ? [`not ${RESTRICTED_SQL}`] : []),
  ];
  let join = "";
  let order = "r.ordinal";
  if (query.sort) {
    const type = query.columns.get(known(query.sort.column_id)) ?? "free";
    join = `left join work.rt_cell s on s.row_id = r.id and s.column_id = ${param(query.sort.column_id)}`;
    order = `${sortExpression(type)} ${query.sort.direction} nulls last, r.ordinal`;
  }
  const page = [
    ...(query.limit !== undefined ? [`limit ${param(query.limit)}`] : []),
    ...(query.offset ? [`offset ${param(query.offset)}`] : []),
  ];
  return {
    sql: `select r.id, r.ordinal, r.document_ids, r.flag_color, r.locked,
                 ${RESTRICTED_SQL} restricted
            from work.rt_row r ${join}
           where ${where.join("\n             and ")}
           order by ${order} ${page.join(" ")}`,
    params,
  };
}
