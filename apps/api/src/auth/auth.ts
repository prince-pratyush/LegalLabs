import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";
import { asApp, type Identity } from "../db.js";
import { verifyPassword } from "./password.js";

// Short enough that a 12 h idle limit holds without tracking activity.
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
  /** When a second factor last passed in this session; null if none did. */
  mfaAt?: Date | null;
  /** A guest of an external Space: let in to /api/v1/guest only, whatever else they ask for. */
  guest?: boolean;
}

export interface Auth {
  login(
    attempt: LoginAttempt,
    client: Client,
  ): Promise<{ token: string; principal: Principal } | null>;
  /** Checks the database every time, so revocation and suspension apply at once. */
  resolve(token: string): Promise<Principal | null>;
  logout(token: string, client: Client): Promise<void>;
}

const NOBODY: Identity = { userId: null, workspaceId: null };

const sha256 = (text: string) => createHash("sha256").update(text).digest();

export const uaHash = (client: Client) =>
  client.userAgent === null ? null : sha256(client.userAgent).toString("hex");

export function createAuth(pool: pg.Pool): Auth {
  const resolve: Auth["resolve"] = async (token) => {
    const row = await asApp(pool, NOBODY, async (db) => {
      const { rows } = await db.query<{
        session_id: string;
        user_id: string;
        workspace_id: string;
        mfa_at: Date | null;
        guest: boolean | null;
      }>(
        `select session_id, user_id, workspace_id, mfa_at, core.guest_live(user_id) as guest
           from core.resolve_session($1)`,
        [sha256(token)],
      );
      return rows[0];
    });
    return row
      ? {
          sessionId: row.session_id,
          userId: row.user_id,
          workspaceId: row.workspace_id,
          mfaAt: row.mfa_at,
          ...(row.guest ? { guest: true } : {}),
        }
      : null;
  };

  return {
    resolve,

    async logout(token, client) {
      const principal = await resolve(token);
      if (!principal) return;
      await asApp(pool, principal, async (db) => {
        const { rowCount } = await db.query(
          "update core.session set revoked_at = now() where id = $1 and revoked_at is null",
          [principal.sessionId],
        );
        if (rowCount === 0) return;
        if (principal.guest) {
          // The audit chain won't take a guest as an actor: record it as the system, naming them.
          await db.query("select set_config('app.user_id', '', true)");
          await db.query(
            "select admin.append_audit_event('logout', 'system', null, 'session', $1, $2, $3, $4)",
            [
              principal.sessionId,
              JSON.stringify({ guest_id: principal.userId }),
              client.ip,
              uaHash(client),
            ],
          );
          return;
        }
        await db.query(
          "select admin.append_audit_event('logout', 'user', $1, 'session', $2, '{}', $3, $4)",
          [principal.userId, principal.sessionId, client.ip, uaHash(client)],
        );
      });
    },

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
      return { token, principal: { sessionId, userId, workspaceId, mfaAt: null } };
    },
  };
}
