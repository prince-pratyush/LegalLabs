import { columnReferences, dependentsOf, findCycle, RT_LIMITS } from "@legallabs/contracts";
import type pg from "pg";
import type { Principal } from "../auth/auth.js";
import { setStatus } from "./history.js";

type Db = pg.PoolClient;

export type Graph = Map<string, string[]>;

/** Each live column of the table and the columns its prompt refers to. */
export async function loadGraph(db: Db, tableId: string): Promise<Graph> {
  const { rows } = await db.query<{ id: string; depends_on: string[] }>(
    "select id, depends_on from work.rt_column where table_id = $1 and deleted_at is null",
    [tableId],
  );
  return new Map(rows.map((r) => [r.id, r.depends_on]));
}

export type Resolved =
  | { ok: true; dependsOn: string[] }
  | { ok: false; code: "INVALID_REQUEST" | "COLUMN_CYCLE"; message: string; path?: string[] };

/**
 * The columns a prompt refers to, checked against the table: each must exist here, and the
 * new references must not close a loop. `columnId` is null for a column not yet created.
 */
export function resolveReferences(
  graph: Graph,
  columnId: string | null,
  type: string,
  prompt: string,
): Resolved {
  // A manual column is typed in; its prompt is a note, never read by a model.
  const refs = type === "manual" ? [] : columnReferences(prompt);
  if (refs.length > RT_LIMITS.references) {
    return {
      ok: false,
      code: "INVALID_REQUEST",
      message: `A prompt can refer to at most ${RT_LIMITS.references} columns.`,
    };
  }
  const unknown = refs.filter((id) => !graph.has(id));
  if (unknown.length > 0) {
    return {
      ok: false,
      code: "INVALID_REQUEST",
      message: "The prompt refers to a column that isn't in this table.",
    };
  }
  if (columnId) {
    const path = findCycle(new Map([...graph, [columnId, refs]]), columnId);
    if (path) {
      return {
        ok: false,
        code: "COLUMN_CYCLE",
        message: "Those references go in a circle: a column can't depend on itself.",
        path,
      };
    }
  }
  return { ok: true, dependsOn: refs };
}

/**
 * Marks the cells of `columnIds` stale, in the given rows or every row. They keep their
 * values and nothing re-runs. Returns how many changed.
 */
export async function markStale(
  db: Db,
  principal: Principal,
  tableId: string,
  columnIds: readonly string[],
  rowIds: readonly string[] | null = null,
): Promise<number> {
  if (columnIds.length === 0) return 0;
  return setStatus(
    db,
    principal,
    `c.table_id = $3 and c.column_id = any($4::uuid[])
       and ($5::uuid[] is null or c.row_id = any($5::uuid[]))
       and c.status in ('done', 'null')`,
    [tableId, columnIds, rowIds],
    "'stale'",
  );
}

/**
 * Answers that rest on a changed cell are out of date: marks the dependents' cells stale,
 * directly or through other columns. Returns how many changed.
 */
export async function markDependentsStale(
  db: Db,
  principal: Principal,
  tableId: string,
  changedColumnIds: readonly string[],
  rowIds: readonly string[] | null = null,
): Promise<number> {
  const dependents = dependentsOf(await loadGraph(db, tableId), changedColumnIds);
  return markStale(db, principal, tableId, dependents, rowIds);
}
