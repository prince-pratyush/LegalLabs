import { createHash, randomBytes } from "node:crypto";
import { BlockList, isIP } from "node:net";
import { PublicApi } from "@legallabs/contracts";
import type pg from "pg";
import type { Client, Principal } from "../auth/auth.js";
import { asApp } from "../db.js";

const { API_SCOPES, TOKEN_MAX_DAYS, TOKEN_PREFIX } = PublicApi;
type ApiScope = PublicApi.ApiScope;

const NOBODY = { userId: null, workspaceId: null };
const OVERLAP_HOURS = 24;
const TOUCH_EVERY = "1 hour";
// 40 characters from a 62-letter alphabet is about 238 bits.
const TOKEN_BODY = /^[A-Za-z0-9]{40}$/;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

const sha256 = (text: string) => createHash("sha256").update(text).digest();

export const looksLikeToken = (text: string) =>
  text.startsWith(TOKEN_PREFIX) && TOKEN_BODY.test(text.slice(TOKEN_PREFIX.length));

function newSecret() {
  let body = "";
  // Rejection sampling, so every letter is equally likely.
  while (body.length < 40) {
    for (const byte of randomBytes(64)) {
      if (byte < 248 && body.length < 40) body += ALPHABET[byte % 62];
    }
  }
  return `${TOKEN_PREFIX}${body}`;
}

export class ApiRefused extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 422,
    readonly code: string,
    message: string,
    readonly extra: object = {},
  ) {
    super(message);
  }
}

export interface Caller {
  principal: Principal;
  tokenId: string;
  scopes: ApiScope[];
  expiresAt: string;
}

export type Authenticated =
  | { ok: true; caller: Caller }
  | { ok: false; status: 401 | 403; code: string; message: string };

export interface IssuedToken {
  token_id: string;
  token: string;
  expires_at: string;
}

export interface PublicApiService {
  /** Checks the secret, its scopes' owner and the network; counts a use at most hourly. */
  authenticate(token: string, ip: string | null): Promise<Authenticated>;
  /** Runs a read as the token's principal, with its scopes visible to row-level security. */
  asCaller<T>(
    caller: Pick<Caller, "principal" | "scopes">,
    work: (db: pg.PoolClient) => Promise<T>,
  ): Promise<T>;
  denied(caller: Caller, route: string, reason: string, client: Client): Promise<void>;
  whoami(caller: Caller): {
    principal_id: string;
    kind: "service";
    workspace_id: string;
    scopes: ApiScope[];
    expires_at: string;
  };
  listAccounts(p: Principal): Promise<unknown[]>;
  createAccount(p: Principal, client: Client, name: string): Promise<unknown>;
  deleteAccount(p: Principal, client: Client, id: string): Promise<void>;
  issueToken(
    p: Principal,
    client: Client,
    accountId: string,
    input: { name: string; scopes: ApiScope[]; days: number; cidrs?: string[] | undefined },
  ): Promise<IssuedToken>;
  revokeToken(p: Principal, client: Client, accountId: string, tokenId: string): Promise<void>;
  rotateToken(
    p: Principal,
    client: Client,
    accountId: string,
    tokenId: string,
  ): Promise<IssuedToken>;
}

/** Whether an address sits inside any of the CIDR blocks; no blocks means anywhere. */
export function ipAllowed(ip: string | null, cidrs: string[]): boolean {
  if (cidrs.length === 0) return true;
  if (ip === null) return false;
  const bare = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  const version = isIP(bare);
  if (version === 0) return false;
  const list = new BlockList();
  for (const cidr of cidrs) {
    const [net, bits] = cidr.split("/");
    const v = isIP(net ?? "");
    if (!net || v === 0) continue;
    list.addSubnet(net, Number(bits ?? (v === 4 ? 32 : 128)), v === 4 ? "ipv4" : "ipv6");
  }
  return list.check(bare, version === 4 ? "ipv4" : "ipv6");
}

export function parseCidrs(cidrs: string[] | undefined): string[] {
  const out: string[] = [];
  for (const cidr of cidrs ?? []) {
    const [net, bits, ...rest] = cidr.split("/");
    const v = isIP(net ?? "");
    const max = v === 4 ? 32 : 128;
    const n = bits === undefined ? max : Number(bits);
    if (v === 0 || rest.length > 0 || !Number.isInteger(n) || n < 0 || n > max) {
      throw new ApiRefused(422, "INVALID_CIDR", `"${cidr}" is not a network address.`);
    }
    out.push(`${net}/${n}`);
  }
  return out;
}

export function createPublicApi(pool: pg.Pool): PublicApiService {
  const as = <T>(p: Principal, work: (db: pg.PoolClient) => Promise<T>) => asApp(pool, p, work);

  const need = async (db: pg.PoolClient) => {
    const { rows } = await db.query<{ ok: boolean }>(
      "select core.has_permission('admin.users') as ok",
    );
    if (!rows[0]?.ok)
      throw new ApiRefused(403, "FORBIDDEN", "You need user admin access for that.");
  };

  const audit = (
    db: pg.PoolClient,
    p: Principal,
    client: Client,
    action: string,
    objectId: string,
    details: object,
  ) =>
    db.query("select admin.append_audit_event($1, 'user', $2, 'api_token', $3, $4, $5, null)", [
      action,
      p.userId,
      objectId,
      JSON.stringify(details),
      client.ip,
    ]);

  const accountOf = async (db: pg.PoolClient, p: Principal, id: string) => {
    const { rows } = await db.query<{ id: string }>(
      `select id from core."user" where workspace_id = $1 and id = $2 and kind = 'service' and email like 'svc\\_%'`,
      [p.workspaceId, id],
    );
    if (!rows[0]) throw new ApiRefused(404, "NOT_FOUND", "That wasn't found.");
  };

  async function insertToken(
    db: pg.PoolClient,
    p: Principal,
    client: Client,
    accountId: string,
    input: {
      name: string;
      scopes: string[];
      days: number;
      cidrs: string[];
      rotatedFrom?: string;
    },
  ): Promise<IssuedToken> {
    const token = newSecret();
    const { rows } = await db.query<{ id: string; expires_at: Date }>(
      `insert into core.api_token
         (workspace_id, principal_id, name, token_hash, scopes, expires_at, cidrs, rotated_from)
       values ($1, $2, $3, $4, $5, now() + make_interval(days => $6), $7::cidr[], $8)
       returning id, expires_at`,
      [
        p.workspaceId,
        accountId,
        input.name,
        sha256(token),
        input.scopes,
        input.days,
        input.cidrs,
        input.rotatedFrom ?? null,
      ],
    );
    const row = rows[0];
    if (!row) throw new Error("token insert returned nothing");
    await audit(db, p, client, input.rotatedFrom ? "token.rotated" : "token.created", row.id, {
      scopes: input.scopes,
      days: input.days,
      cidrs: input.cidrs.length,
      ...(input.rotatedFrom ? { replaces: input.rotatedFrom } : {}),
    });
    return { token_id: row.id, token, expires_at: row.expires_at.toISOString() };
  }

  return {
    async authenticate(token, ip) {
      if (!looksLikeToken(token)) {
        return { ok: false, status: 401, code: "UNAUTHENTICATED", message: "Sign in first." };
      }
      const row = await asApp(pool, NOBODY, async (db) => {
        const { rows } = await db.query<{
          token_id: string;
          principal_id: string;
          workspace_id: string;
          scopes: string[];
          expires_at: Date;
          cidrs: string[];
        }>("select * from core.resolve_public_token($1)", [sha256(token)]);
        return rows[0];
      });
      if (!row) {
        return { ok: false, status: 401, code: "UNAUTHENTICATED", message: "Sign in first." };
      }
      const principal: Principal = {
        sessionId: row.token_id,
        userId: row.principal_id,
        workspaceId: row.workspace_id,
        mfaAt: null,
      };
      if (!ipAllowed(ip, row.cidrs)) {
        await as(principal, (db) =>
          db.query(
            "select admin.append_audit_event('token.used_denied', 'service', $1, 'api_token', $2, $3, $4, null)",
            [row.principal_id, row.token_id, JSON.stringify({ reason: "ip" }), ip],
          ),
        );
        return {
          ok: false,
          status: 403,
          code: "IP_NOT_ALLOWED",
          message: "This address is not allowed.",
        };
      }
      await as(principal, (db) =>
        db.query(
          `update core.api_token set last_used_at = now()
            where id = $1 and (last_used_at is null or last_used_at < now() - interval '${TOUCH_EVERY}')`,
          [row.token_id],
        ),
      );
      const known = new Set<string>(API_SCOPES);
      return {
        ok: true,
        caller: {
          principal,
          tokenId: row.token_id,
          scopes: row.scopes.filter((s): s is ApiScope => known.has(s)),
          expiresAt: row.expires_at.toISOString(),
        },
      };
    },

    asCaller(caller, work) {
      return as(caller.principal, async (db) => {
        // Local to this transaction: the policies read it, and it dies with the connection's turn.
        await db.query("select set_config('app.api_scopes', $1, true)", [caller.scopes.join(",")]);
        return work(db);
      });
    },

    async denied(caller, route, reason, client) {
      await as(caller.principal, (db) =>
        db.query(
          "select admin.append_audit_event('token.used_denied', 'service', $1, 'api_token', $2, $3, $4, null)",
          [caller.principal.userId, caller.tokenId, JSON.stringify({ reason, route }), client.ip],
        ),
      );
    },

    whoami: (caller) => ({
      principal_id: caller.principal.userId,
      kind: "service",
      workspace_id: caller.principal.workspaceId,
      scopes: caller.scopes,
      expires_at: caller.expiresAt,
    }),

    listAccounts: (p) =>
      as(p, async (db) => {
        await need(db);
        const { rows } = await db.query(
          `select u.id, u.name, u.created_at,
                  coalesce(json_agg(json_build_object(
                    'id', t.id, 'name', t.name, 'scopes', t.scopes, 'cidrs', t.cidrs::text[],
                    'expires_at', t.expires_at, 'last_used_at', t.last_used_at,
                    'revoked_at', t.revoked_at) order by t.created_at)
                    filter (where t.id is not null), '[]') as tokens
             from core."user" u
             left join core.api_token t on t.workspace_id = u.workspace_id and t.principal_id = u.id
            where u.workspace_id = $1 and u.kind = 'service' and u.email like 'svc\\_%'
              and u.status = 'active'
            group by u.id order by u.created_at`,
          [p.workspaceId],
        );
        return rows;
      }),

    createAccount: (p, client, name) =>
      as(p, async (db) => {
        await need(db);
        const email = `svc_${name}@service.invalid`;
        const taken = await db.query(
          `select 1 from core."user" where workspace_id = $1 and lower(email) = $2`,
          [p.workspaceId, email],
        );
        if (taken.rowCount) throw new ApiRefused(409, "NAME_TAKEN", "That name is already used.");
        const { rows } = await db.query<{ id: string; created_at: Date }>(
          `insert into core."user" (workspace_id, email, name, kind, status)
           values ($1, $2, $3, 'service', 'active') returning id, created_at`,
          [p.workspaceId, email, `svc_${name}`],
        );
        const row = rows[0];
        await db.query(
          "select admin.append_audit_event('settings.changed', 'user', $1, 'user', $2, $3, $4, null)",
          [p.userId, row?.id, JSON.stringify({ key: "service_account_created" }), client.ip],
        );
        return { id: row?.id, name: `svc_${name}`, created_at: row?.created_at, tokens: [] };
      }),

    deleteAccount: (p, client, id) =>
      as(p, async (db) => {
        await need(db);
        await accountOf(db, p, id);
        const revoked = await db.query<{ id: string }>(
          `update core.api_token set revoked_at = now()
            where workspace_id = $1 and principal_id = $2 and revoked_at is null returning id`,
          [p.workspaceId, id],
        );
        await db.query(`update core."user" set status = 'deprovisioned' where id = $1`, [id]);
        await db.query(
          "select admin.append_audit_event('settings.changed', 'user', $1, 'user', $2, $3, $4, null)",
          [p.userId, id, JSON.stringify({ key: "service_account_deleted" }), client.ip],
        );
        for (const t of revoked.rows)
          await audit(db, p, client, "token.revoked", t.id, { why: "account_deleted" });
      }),

    issueToken: (p, client, accountId, input) =>
      as(p, async (db) => {
        await need(db);
        await accountOf(db, p, accountId);
        if (input.days > TOKEN_MAX_DAYS) {
          throw new ApiRefused(422, "EXPIRY_MAX", `Tokens last at most ${TOKEN_MAX_DAYS} days.`);
        }
        const cidrs = parseCidrs(input.cidrs);
        return insertToken(db, p, client, accountId, { ...input, cidrs });
      }),

    revokeToken: (p, client, accountId, tokenId) =>
      as(p, async (db) => {
        await need(db);
        await accountOf(db, p, accountId);
        const r = await db.query(
          `update core.api_token set revoked_at = now()
            where id = $1 and principal_id = $2 and revoked_at is null`,
          [tokenId, accountId],
        );
        if (r.rowCount === 0) throw new ApiRefused(404, "NOT_FOUND", "That wasn't found.");
        await audit(db, p, client, "token.revoked", tokenId, {});
      }),

    rotateToken: (p, client, accountId, tokenId) =>
      as(p, async (db) => {
        await need(db);
        await accountOf(db, p, accountId);
        const { rows } = await db.query<{
          name: string;
          scopes: string[];
          cidrs: string[];
          expires_at: Date;
          days: number;
        }>(
          `select name, scopes, cidrs::text[] as cidrs, expires_at,
                  greatest(1, ceil(extract(epoch from (expires_at - created_at)) / 86400))::int as days
             from core.api_token
            where id = $1 and principal_id = $2 and revoked_at is null and expires_at > now()`,
          [tokenId, accountId],
        );
        const old = rows[0];
        if (!old) throw new ApiRefused(404, "NOT_FOUND", "That wasn't found.");
        const issued = await insertToken(db, p, client, accountId, {
          name: old.name,
          scopes: old.scopes,
          days: Math.min(old.days, TOKEN_MAX_DAYS),
          cidrs: old.cidrs,
          rotatedFrom: tokenId,
        });
        // The old secret keeps working for a day so a deployment can cut over without downtime.
        await db.query(
          `update core.api_token set expires_at = least(expires_at, now() + make_interval(hours => $2))
            where id = $1`,
          [tokenId, OVERLAP_HOURS],
        );
        return issued;
      }),
  };
}
