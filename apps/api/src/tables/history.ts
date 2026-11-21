import type { Principal } from "../auth/auth.js";

interface Db {
  query(sql: string, params: unknown[]): Promise<{ rowCount: number | null }>;
}

/**
 * Changes the status of the cells `where` picks and records each change in the cell's history,
 * in one statement. `where` and `status` are SQL over the cell (alias c); params start at $3.
 */
export async function setStatus(
  db: Db,
  principal: Principal,
  where: string,
  params: unknown[],
  status: string,
): Promise<number> {
  const { rowCount } = await db.query(
    `with old as (
       select c.id, c.status from work.rt_cell c where ${where} for update
     ), changed as (
       update work.rt_cell c
          set status = ${status},
              stale_since = case when ${status} = 'stale' then now() else null end,
              updated_at = now()
         from old where c.id = old.id
       returning c.id, c.table_id, old.status before, c.status after
     )
     insert into work.rt_cell_history (workspace_id, table_id, cell_id, actor_id, field, old, new)
     select $1, table_id, id, $2, 'status', to_jsonb(before), to_jsonb(after) from changed`,
    [principal.workspaceId, principal.userId, ...params],
  );
  return rowCount ?? 0;
}
