import type pg from "pg";

export interface Identity {
  userId: string | null;
  workspaceId: string | null;
}

// Every query runs as the app role, so row-level security applies from the first statement.
export const RLS_REFUSED = "42501";

export function asApp<T>(
  pool: pg.Pool,
  identity: Identity,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  return asRole(pool, "legallabs_app", identity, work);
}

// Claims ingest jobs across workspaces, so it never runs with a person's identity.
export function asWorker<T>(pool: pg.Pool, work: (client: pg.PoolClient) => Promise<T>) {
  return asRole(pool, "legallabs_worker", { userId: null, workspaceId: null }, work);
}

async function asRole<T>(
  pool: pg.Pool,
  role: "legallabs_app" | "legallabs_worker",
  identity: Identity,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`set local role ${role}`);
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
