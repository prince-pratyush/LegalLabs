import type pg from "pg";

export interface Identity {
  userId: string;
  workspaceId: string;
}

/** One transaction as the run's owner, so row-level security applies to every query. */
export async function asUser<T>(
  pool: pg.Pool,
  who: Identity,
  work: (db: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local role legallabs_app");
    await client.query(
      "select set_config('app.user_id', $1, true), set_config('app.workspace_id', $2, true)",
      [who.userId, who.workspaceId],
    );
    const result = await work(client);
    await client.query("commit");
    client.release();
    return result;
  } catch (err) {
    client.release(err instanceof Error ? err : true);
    throw err;
  }
}
