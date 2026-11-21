import type pg from "pg";
import { type Client, type Principal, uaHash } from "./auth.js";

/**
 * Appends one audit event as the signed-in person. Details are ids, counts and sources only:
 * never the text of a memory, a notification or a prompt.
 */
export const audit = (
  db: pg.PoolClient,
  p: Principal,
  client: Client,
  action: string,
  objectType: string,
  objectId: string,
  details: object = {},
) =>
  db.query("select admin.append_audit_event($1, 'user', $2, $3, $4, $5, $6, $7)", [
    action,
    p.userId,
    objectType,
    objectId,
    JSON.stringify(details),
    client.ip,
    uaHash(client),
  ]);
