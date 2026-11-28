import type pg from "pg";
import { type Client, type Principal, uaHash } from "../auth/auth.js";
import { asApp, RLS_REFUSED } from "../db.js";

// What every kind of intake channel shares in its settings: who may change them, and the audit.

export type ChannelFailure =
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "NAME_TAKEN"
  | "TOO_MANY_CHANNELS"
  | "SECRETS_UNAVAILABLE";

export type ChannelResult<T> = { ok: true; value: T } | { ok: false; reason: ChannelFailure };

export const MAX_CHANNELS = 10;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class Refused extends Error {
  constructor(readonly reason: ChannelFailure) {
    super(reason);
  }
}
export const refuse = (reason: ChannelFailure): never => {
  throw new Refused(reason);
};

export async function managed<T>(
  pool: pg.Pool,
  principal: Principal,
  work: (db: pg.PoolClient) => Promise<T>,
): Promise<ChannelResult<T>> {
  try {
    const value = await asApp(pool, principal, async (db) => {
      const { rows } = await db.query<{ ok: boolean }>(
        "select apps.intake_may('intake.manage') ok",
      );
      if (!rows[0]?.ok) refuse("FORBIDDEN");
      return work(db);
    });
    return { ok: true, value };
  } catch (err) {
    if (err instanceof Refused) return { ok: false, reason: err.reason };
    const { code } = err as { code?: string };
    if (code === RLS_REFUSED) return { ok: false, reason: "FORBIDDEN" };
    if (code === "23505") return { ok: false, reason: "NAME_TAKEN" };
    throw err;
  }
}

export const channelAudit = (
  db: pg.PoolClient,
  principal: Principal,
  action: string,
  id: string,
  details: object,
  client: Client,
) =>
  db.query("select admin.append_audit_event($1, 'user', $2, 'intake_channel', $3, $4, $5, $6)", [
    action,
    principal.userId,
    id,
    JSON.stringify(details),
    client.ip,
    uaHash(client),
  ]);

/** Refuses once the workspace has as many channels, of every kind, as it can. */
export async function roomForChannel(db: pg.PoolClient): Promise<void> {
  const count = await db.query<{ n: string }>("select count(*) n from apps.intake_channel");
  if (Number(count.rows[0]?.n) >= MAX_CHANNELS) refuse("TOO_MANY_CHANNELS");
}
