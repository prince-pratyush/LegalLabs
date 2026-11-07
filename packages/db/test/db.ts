import pg from "pg";
import { inject } from "vitest";

export type Row = Record<string, unknown>;

export class Tx {
  constructor(private readonly client: pg.Client) {}

  async rows<T extends Row = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await this.client.query<T>(sql, params)).rows;
  }

  async one<T extends Row = Row>(sql: string, params: unknown[] = []): Promise<T> {
    const [row] = await this.rows<T>(sql, params);
    if (!row) throw new Error(`no row: ${sql}`);
    return row;
  }

  // Acts as the API would: the app role, with only the settings a request sets.
  async as(userId: string | null, workspaceId: string | null): Promise<void> {
    await this.client.query("set local role legallabs_app");
    await this.client.query(
      "select set_config('app.user_id', $1, true), set_config('app.workspace_id', $2, true)",
      [userId ?? "", workspaceId ?? ""],
    );
  }

  async asOwner(): Promise<void> {
    await this.client.query("reset role");
  }

  // Returns the error message, keeping the transaction usable afterwards.
  async error(sql: string, params: unknown[] = []): Promise<string | undefined> {
    await this.client.query("savepoint attempt");
    try {
      await this.client.query(sql, params);
      await this.client.query("release savepoint attempt");
      return undefined;
    } catch (err) {
      await this.client.query("rollback to savepoint attempt");
      return err instanceof Error ? err.message : String(err);
    }
  }
}

// Rolling back keeps tests independent and leaves no data behind.
export async function withTx(fn: (tx: Tx) => Promise<void>): Promise<void> {
  const client = new pg.Client({ connectionString: inject("databaseUrl") });
  await client.connect();
  try {
    await client.query("begin");
    await fn(new Tx(client));
  } finally {
    await client.query("rollback").catch(() => undefined);
    await client.end();
  }
}
