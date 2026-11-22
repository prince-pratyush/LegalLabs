import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";
import { type Client, type Principal, SESSION_SECONDS, uaHash } from "../auth.js";

/**
 * The same insert and audit as password sign-in, for a person the IdP has vouched for.
 * Runs inside the caller's transaction, whose identity must already be this user.
 */
export async function insertSession(
  db: pg.PoolClient,
  who: { userId: string; workspaceId: string },
  client: Client,
  opts: { mfa: boolean; details?: object },
): Promise<{ token: string; principal: Principal }> {
  const token = randomBytes(32).toString("base64url");
  const { rows } = await db.query<{ id: string }>(
    `insert into core.session (workspace_id, user_id, token_hash, expires_at, ip, ua_hash, mfa_at)
     values ($1, $2, $3, now() + make_interval(secs => $4), $5, $6, case when $7 then now() end)
     returning id`,
    [
      who.workspaceId,
      who.userId,
      createHash("sha256").update(token).digest(),
      SESSION_SECONDS,
      client.ip,
      uaHash(client),
      opts.mfa,
    ],
  );
  const sessionId = rows[0]?.id ?? "";
  // Last in the transaction: an audit failure must undo the sign-in it describes.
  await db.query(
    "select admin.append_audit_event('login.success', 'user', $1, 'session', $2, $3, $4, $5)",
    [who.userId, sessionId, JSON.stringify(opts.details ?? {}), client.ip, uaHash(client)],
  );
  return { token, principal: { sessionId, userId: who.userId, workspaceId: who.workspaceId } };
}
