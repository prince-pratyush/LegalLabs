import type pg from "pg";
import { type Client, type Principal, uaHash } from "../auth/auth.js";

/** One audit event about a table. Ids and counts only: values and prompts stay out of the log. */
export const audit = (
  db: pg.PoolClient,
  principal: Principal,
  client: Client,
  action: string,
  tableId: string,
  details: object = {},
) =>
  db.query("select admin.append_audit_event($1, 'user', $2, 'table', $3, $4, $5, $6)", [
    action,
    principal.userId,
    tableId,
    JSON.stringify(details),
    client.ip,
    uaHash(client),
  ]);
