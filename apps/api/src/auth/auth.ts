import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";
import { verifyPassword } from "./password.js";

// Under the 7-day cap, and short enough that the spec's 12 h idle limit holds without tracking use.
export const SESSION_SECONDS = 12 * 60 * 60;

export interface LoginAttempt {
  workspace: string;
  email: string;
  password: string;
}

export interface Client {
  ip: string | null;
  userAgent: string | null;
}

export interface Principal {
  sessionId: string;
  userId: string;
  workspaceId: string;
}

export interface Auth {
  login(
    attempt: LoginAttempt,
    client: Client,
  ): Promise<{ token: string; principal: Principal } | null>;
}

interface Identity {
  userId: string | null;
  workspaceId: string | null;
}

const NOBODY: Identity = { userId: null, workspaceId: null };

const sha256 = (text: string) => createHash("sha256").update(text).digest();

// Every query runs as the app role, so row-level security applies from the first statement.
async function asApp<T>(
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

export function createAuth(pool: pg.Pool): Auth {
  const uaHash = (client: Client) =>
    client.userAgent === null ? null : sha256(client.userAgent).toString("hex");

  return {
    async login(attempt, client) {
      // Closed before hashing, so slow password checks never hold a connection.
      const row = await asApp(pool, NOBODY, async (db) => {
        const { rows } = await db.query<{
          workspace_id: string;
          user_id: string | null;
          status: string | null;
          password_hash: string | null;
        }>("select * from core.find_login_credential($1, $2)", [attempt.workspace, attempt.email]);
        return rows[0];
      });
      const matches = await verifyPassword(row?.password_hash ?? null, attempt.password);
      if (!row) return null; // No workspace means no audit log to write to.

      const reason = !row.user_id
        ? "unknown_user"
        : !row.password_hash
          ? "no_password"
          : !matches
            ? "bad_password"
            : row.status !== "active"
              ? "not_active"
              : null;
      if (reason !== null || !row.user_id) {
        await asApp(pool, { userId: null, workspaceId: row.workspace_id }, (db) =>
          db.query(
            "select admin.append_audit_event('login.failure', 'system', null, $1, $2, $3, $4, $5)",
            [
              row.user_id ? "user" : null,
              row.user_id,
              JSON.stringify({ reason }),
              client.ip,
              uaHash(client),
            ],
          ),
        );
        return null;
      }

      const userId = row.user_id;
      const workspaceId = row.workspace_id;
      const token = randomBytes(32).toString("base64url");
      const sessionId = await asApp(pool, { userId, workspaceId }, async (db) => {
        const { rows } = await db.query<{ id: string }>(
          `insert into core.session (workspace_id, user_id, token_hash, expires_at, ip, ua_hash)
           values ($1, $2, $3, now() + make_interval(secs => $4), $5, $6) returning id`,
          [workspaceId, userId, sha256(token), SESSION_SECONDS, client.ip, uaHash(client)],
        );
        const id = rows[0]?.id ?? "";
        // Last in the transaction: an audit failure must undo the sign-in it describes.
        await db.query(
          "select admin.append_audit_event('login.success', 'user', $1, 'session', $2, '{}', $3, $4)",
          [userId, id, client.ip, uaHash(client)],
        );
        return id;
      });
      return { token, principal: { sessionId, userId, workspaceId } };
    },
  };
}
