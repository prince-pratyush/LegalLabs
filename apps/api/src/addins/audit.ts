import type pg from "pg";
import { type Client, type Principal, uaHash } from "../auth/auth.js";
import { asApp } from "../db.js";

/** Records a pane's sign-in as its own event, so admins can tell its use from web use. */
export const createSignInAudit =
  (pool: pg.Pool) =>
  (principal: Principal, client: Client, surface: "word" | "outlook" = "word") =>
    asApp(pool, principal, async (db) => {
      await db.query(
        "select admin.append_audit_event('addin.signed_in', 'user', $1, 'session', $2, $3, $4, $5)",
        [
          principal.userId,
          principal.sessionId,
          JSON.stringify({ surface }),
          client.ip,
          uaHash(client),
        ],
      );
    });
