import type pg from "pg";

export interface Identity {
  userId: string | null;
  workspaceId: string | null;
}

// Every query runs as the app role, so row-level security applies from the first statement.
export async function asApp<T>(
  pool: pg.Pool,
  identity: Identity,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local role legallabs_app");
    await client.query(
      "select set_config('app.user_id', $1, true), set_config('app.workspace_id', $2, true)",
      [identity.userId ?? "", identity.workspaceId ?? ""],
    );
    const result = await work(client);
    await client.query("commit");
    client.release();
    return result;
  } catch (err) {
    // Destroyed rather than reused, because its transaction state is unknown.
    client.release(err instanceof Error ? err : true);
    throw err;
  }
}
