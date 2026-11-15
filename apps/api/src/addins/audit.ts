import type pg from "pg";
import { type Client, type Principal, uaHash } from "../auth/auth.js";
import { asApp } from "../db.js";

/** Records the pane's sign-in as its own event, so admins can tell Word use from web use. */
export const createSignInAudit = (pool: pg.Pool) => (principal: Principal, client: Client) =>
  asApp(pool, principal, async (db) => {
    await db.query(
      "select admin.append_audit_event('addin.signed_in', 'user', $1, 'session', $2, $3, $4, $5)",
      [
        principal.userId,
        principal.sessionId,
        JSON.stringify({ surface: "word" }),
        client.ip,
        uaHash(client),
      ],
    );
  });
