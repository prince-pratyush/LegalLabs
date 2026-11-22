import { PublicApi } from "@legallabs/contracts";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ZodType } from "zod";
import type { Client, Principal } from "../auth/auth.js";
import { createLimiter, type Limiter } from "../auth/limiter.js";
import { FRESH_MFA_MS, hasFreshMfa } from "../auth/mfa/step-up.js";
import { toCsv } from "../command-center/csv.js";
import type { Vaults } from "../vaults/vaults.js";
import { ApiRefused, type Caller, type PublicApiService } from "./service.js";

const { operations, AuditEventsQuery, QueryHistoryQuery, VaultTreeQuery } = PublicApi;

type Env = { Variables: { principal: Principal; caller?: Caller } };

const DAY_MS = 86_400_000;
const small = bodyLimit({
  maxSize: 16 * 1024,
  onError: (c) =>
    c.json({ code: "INVALID_REQUEST", message: "Check the details and try again." }, 400),
});
const invalid = (c: Context) =>
  c.json({ code: "INVALID_REQUEST", message: "Check the details and try again." }, 400);
const notFound = (c: Context) => c.json({ code: "NOT_FOUND", message: "That wasn't found." }, 404);
const uuid = (text: string | undefined) =>
  text !== undefined && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text)
    ? text
    : null;

function refusal(c: Context, err: unknown) {
  if (err instanceof ApiRefused) {
    return c.json({ code: err.code, message: err.message, ...err.extra }, err.status);
  }
  throw err;
}

// "/vaults/{id}/tree" becomes a pattern that matches "/vaults/<anything>/tree".
const matchers = operations.map((op) => ({
  op,
  re: new RegExp(`^${op.path.replace(/\{[^}]+\}/g, "[^/]+").replaceAll(".", "\\.")}$`),
}));

export const operationFor = (method: string, path: string) =>
  matchers.find((m) => m.op.method === method.toLowerCase() && m.re.test(path))?.op;

/**
 * Applied to every request made with an API token, after it is verified. A token reaches only
 * the operations the spec lists, and only with the scope that operation names.
 */
export function tokenGate(
  api: PublicApiService,
  clientOf: (c: Context) => Client,
  limiter: Limiter,
): MiddlewareHandler<Env> {
  return async (c, next) => {
    const caller = c.get("caller");
    if (!caller) return next();
    const wait = limiter.take(caller.tokenId);
    if (wait > 0) {
      c.header("Retry-After", String(wait));
      return c.json({ code: "RATE_LIMITED", message: "Too many requests. Slow down." }, 429);
    }
    const path = c.req.path.replace(/^\/api\/v1/, "");
    const op = operationFor(c.req.method, path);
    const refuse = async (reason: string) => {
      await api.denied(caller, `${c.req.method} ${path}`, reason, clientOf(c));
      return c.json(
        { code: "FORBIDDEN_SCOPE", message: "This token is not allowed to do that." },
        403,
      );
    };
    if (!op || op.scope === "session") return refuse("route");
    if (op.scope !== "any_token" && !caller.scopes.includes(op.scope)) return refuse(op.scope);
    return next();
  };
}

export const tokenLimiter = (now?: () => number) =>
  createLimiter({
    limit: PublicApi.RATE_LIMIT_PER_MINUTE,
    windowMs: 60_000,
    ...(now ? { now } : {}),
  });

export interface PublicApiRoutesOptions {
  api: PublicApiService;
  vaults?: Vaults | undefined;
  clientOf: (c: Context) => Client;
  /** True when a person has a second factor, so issuing a token asks for a fresh one. */
  hasFactor?: ((p: Principal) => Promise<boolean>) | undefined;
  now?: () => number;
}

function readRange(from: string | undefined, to: string | undefined, now: number) {
  const end = to === undefined ? now : Date.parse(to);
  const start = from === undefined ? undefined : Date.parse(from);
  if (Number.isNaN(end) || (start !== undefined && Number.isNaN(start))) return null;
  return { start, end };
}

export function publicApiRoutes({
  api,
  vaults,
  clientOf,
  hasFactor,
  now = Date.now,
}: PublicApiRoutesOptions) {
  const app = new Hono<Env>();
  const caller = (c: Context<Env>) => c.get("caller");
  const scopesOf = (c: Context<Env>) => caller(c)?.scopes ?? [];
  const run = <T>(c: Context<Env>, work: Parameters<PublicApiService["asCaller"]>[1]) =>
    api.asCaller({ principal: c.get("principal"), scopes: scopesOf(c) }, work) as Promise<T>;

  app.get("/whoami", async (c) => {
    const who = caller(c);
    if (who) return c.json(api.whoami(who));
    const p = c.get("principal");
    return c.json({
      principal_id: p.userId,
      kind: "user",
      workspace_id: p.workspaceId,
      scopes: [],
      expires_at: null,
    });
  });

  // Filters shared by the page and the CSV, so the two always agree.
  function auditFilter(c: Context<Env>, query: Record<string, string | number | undefined>) {
    const range = readRange(
      query.from as string | undefined,
      query.to as string | undefined,
      now(),
    );
    if (!range) return invalid(c);
    const start = range.start ?? range.end - PublicApi.AUDIT_MAX_RANGE_DAYS * DAY_MS;
    if (start >= range.end) return invalid(c);
    if (range.end - start > PublicApi.AUDIT_MAX_RANGE_DAYS * DAY_MS) {
      return c.json({ code: "RANGE_TOO_LARGE", message: "Ask for at most 7 days at a time." }, 422);
    }
    const where = ["at >= $1", "at < $2"];
    const params: unknown[] = [new Date(start), new Date(range.end)];
    for (const [key, column] of [
      ["filter[action]", "action"],
      ["filter[actor_id]", "actor_id"],
      ["filter[object_type]", "object_type"],
      ["filter[object_id]", "object_id"],
    ] as const) {
      const value = query[key] as string | undefined;
      if (value === undefined) continue;
      params.push(value);
      where.push(`${column} = $${params.length}`);
    }
    return { where, params };
  }

  const auditColumns = `seq, at, actor_type, actor_id, action, object_type, object_id, details, host(ip) as ip`;
  const auditRow = (r: Record<string, unknown>) => ({
    seq: Number(r.seq),
    at: (r.at as Date).toISOString(),
    actor_type: r.actor_type,
    actor_id: r.actor_id,
    action: r.action,
    object_type: r.object_type,
    object_id: r.object_id,
    details: r.details,
    ip: r.ip,
  });

  app.get("/audit/events/export.csv", async (c) => {
    const parsed = AuditEventsQuery.omit({ cursor: true, limit: true }).safeParse(c.req.query());
    if (!parsed.success) return invalid(c);
    const filter = auditFilter(c, parsed.data);
    if (filter instanceof Response) return filter;
    const sql = `from admin.audit_event where ${filter.where.join(" and ")}`;
    const rows = await run<Record<string, unknown>[] | { count: number }>(c, async (db) => {
      const count = Number(
        (await db.query<{ n: string }>(`select count(*) as n ${sql}`, filter.params)).rows[0]?.n,
      );
      if (count > PublicApi.AUDIT_EXPORT_MAX) return { count };
      return (await db.query(`select ${auditColumns} ${sql} order by seq desc`, filter.params))
        .rows;
    });
    if (!Array.isArray(rows)) {
      return c.json(
        {
          code: "EXPORT_TOO_LARGE",
          message: "That is more than 20,000 events. Narrow the range.",
          count: rows.count,
        },
        422,
      );
    }
    const body = toCsv(
      [
        "seq",
        "at",
        "actor_type",
        "actor_id",
        "action",
        "object_type",
        "object_id",
        "details",
        "ip",
      ],
      rows.map((r) => {
        const e = auditRow(r);
        return [
          e.seq,
          e.at,
          e.actor_type as string,
          e.actor_id as string | null,
          e.action as string,
          e.object_type as string | null,
          e.object_id as string | null,
          JSON.stringify(e.details),
          e.ip as string | null,
        ];
      }),
    );
    return c.body(body, 200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="audit-events.csv"',
    });
  });

  app.get("/audit/events", async (c) => {
    const parsed = AuditEventsQuery.safeParse(c.req.query());
    if (!parsed.success) return invalid(c);
    const q = parsed.data;
    const filter = auditFilter(c, q);
    if (filter instanceof Response) return filter;
    if (q.cursor !== undefined) {
      if (!/^\d{1,15}$/.test(q.cursor)) return invalid(c);
      filter.params.push(q.cursor);
      filter.where.push(`seq < $${filter.params.length}`);
    }
    filter.params.push(q.limit + 1);
    const rows = await run<Record<string, unknown>[]>(
      c,
      async (db) =>
        (
          await db.query(
            `select ${auditColumns} from admin.audit_event where ${filter.where.join(" and ")}
            order by seq desc limit $${filter.params.length}`,
            filter.params,
          )
        ).rows,
    );
    const page = rows.slice(0, q.limit).map(auditRow);
    const more = rows.length > q.limit;
    return c.json({ events: page, next_cursor: more ? String(page.at(-1)?.seq) : null });
  });

  app.get("/history/queries", async (c) => {
    const parsed = QueryHistoryQuery.safeParse(c.req.query());
    if (!parsed.success) return invalid(c);
    const q = parsed.data;
    const range = readRange(q.from, q.to, now());
    if (!range) return invalid(c);
    const where = ["action_class = 'query'", "at < $1"];
    const params: unknown[] = [new Date(range.end)];
    if (range.start !== undefined) {
      params.push(new Date(range.start));
      where.push(`at >= $${params.length}`);
    }
    if (q.cursor !== undefined) {
      if (!uuid(q.cursor)) return invalid(c);
      params.push(q.cursor);
      where.push(`id < $${params.length}`);
    }
    params.push(q.limit + 1);
    const rows = await run<Record<string, unknown>[]>(
      c,
      async (db) =>
        (
          await db.query(
            `select id, at, user_id, access_point, surface, action, model, document_count,
                  input_tokens, output_tokens
             from analytics.usage_event where ${where.join(" and ")}
            order by id desc limit $${params.length}`,
            params,
          )
        ).rows,
    );
    const page = rows.slice(0, q.limit).map((r) => ({ ...r, at: (r.at as Date).toISOString() }));
    return c.json({
      queries: page,
      next_cursor:
        rows.length > q.limit
          ? String((rows[q.limit - 1] as { id: string } | undefined)?.id)
          : null,
    });
  });

  // Vaults already have routes for people; these answer only for a token and otherwise step aside.
  if (vaults) {
    app.get("/vaults", async (c, next) => {
      if (!caller(c)) return next();
      const found = await vaults.list(c.get("principal"));
      return c.json({
        vaults: found.map((v) => ({
          id: v.id,
          name: v.name,
          description: v.description,
          matter_id: v.matterId,
          files: v.files,
          created_at: v.createdAt,
          updated_at: v.updatedAt,
        })),
      });
    });
    app.get("/vaults/:id", async (c, next) => {
      if (!caller(c)) return next();
      const id = uuid(c.req.param("id"));
      const found = id ? await vaults.get(c.get("principal"), id) : null;
      if (!found) return notFound(c);
      const v = found.vault;
      return c.json({
        vault: {
          id: v.id,
          name: v.name,
          description: v.description,
          matter_id: v.matterId,
          files: found.stats.files,
          created_at: v.createdAt,
          updated_at: v.updatedAt,
        },
      });
    });
    app.get("/vaults/:id/tree", async (c, next) => {
      if (!caller(c)) return next();
      const id = uuid(c.req.param("id"));
      const parsed = VaultTreeQuery.safeParse(c.req.query());
      if (!id || !parsed.success) return id ? invalid(c) : notFound(c);
      const { folder_id, cursor, limit } = parsed.data;
      const tree = await vaults.tree(c.get("principal"), id, {
        folderId: folder_id ?? null,
        cursor: cursor ?? null,
        ...(limit === undefined ? {} : { limit }),
      });
      if (!tree) return notFound(c);
      return c.json({
        folders: tree.folders.map((f) => ({ id: f.id, name: f.name, parent_id: f.parentId })),
        files: tree.files.map((f) => ({
          id: f.id,
          folder_id: f.folderId,
          name: f.name,
          mime: f.mime,
          size: f.size,
          state: f.state,
          updated_at: f.updatedAt,
        })),
        next_cursor: tree.nextCursor,
      });
    });
  }

  // People who administer users issue the tokens; a token can never reach these.
  const body = async <T>(c: Context<Env>, schema: ZodType<T>): Promise<T | null> => {
    const parsed = schema.safeParse(await c.req.json().catch(() => null));
    return parsed.success ? parsed.data : null;
  };
  const stepUp = async (c: Context<Env>) => {
    const p = c.get("principal");
    if (hasFactor && !hasFreshMfa(p, FRESH_MFA_MS, now()) && (await hasFactor(p))) {
      return c.json(
        { code: "MFA_REQUIRED", message: "Confirm with your second factor to continue." },
        403,
      );
    }
    return null;
  };

  app.get("/admin/service-accounts", async (c) => {
    try {
      return c.json({ service_accounts: await api.listAccounts(c.get("principal")) });
    } catch (err) {
      return refusal(c, err);
    }
  });
  app.post("/admin/service-accounts", small, async (c) => {
    const input = await body(c, PublicApi.ServiceAccountBody);
    if (!input) return invalid(c);
    try {
      return c.json(await api.createAccount(c.get("principal"), clientOf(c), input.name), 201);
    } catch (err) {
      return refusal(c, err);
    }
  });
  app.delete("/admin/service-accounts/:id", async (c) => {
    const id = uuid(c.req.param("id"));
    if (!id) return notFound(c);
    try {
      await api.deleteAccount(c.get("principal"), clientOf(c), id);
      return c.body(null, 204);
    } catch (err) {
      return refusal(c, err);
    }
  });
  app.post("/admin/service-accounts/:id/tokens", small, async (c) => {
    const id = uuid(c.req.param("id"));
    if (!id) return notFound(c);
    const input = await body(c, PublicApi.TokenBody);
    if (!input) return invalid(c);
    const gate = await stepUp(c);
    if (gate) return gate;
    try {
      const issued = await api.issueToken(c.get("principal"), clientOf(c), id, {
        name: input.name,
        scopes: [...new Set(input.scopes)],
        days: input.expires_in_days,
        cidrs: input.cidrs,
      });
      c.header("Cache-Control", "no-store");
      return c.json(issued, 201);
    } catch (err) {
      return refusal(c, err);
    }
  });
  app.post("/admin/service-accounts/:id/tokens/:tokenId/revoke", async (c) => {
    const id = uuid(c.req.param("id"));
    const tokenId = uuid(c.req.param("tokenId"));
    if (!id || !tokenId) return notFound(c);
    try {
      await api.revokeToken(c.get("principal"), clientOf(c), id, tokenId);
      return c.body(null, 204);
    } catch (err) {
      return refusal(c, err);
    }
  });
  app.post("/admin/service-accounts/:id/tokens/:tokenId/rotate", async (c) => {
    const id = uuid(c.req.param("id"));
    const tokenId = uuid(c.req.param("tokenId"));
    if (!id || !tokenId) return notFound(c);
    const gate = await stepUp(c);
    if (gate) return gate;
    try {
      const issued = await api.rotateToken(c.get("principal"), clientOf(c), id, tokenId);
      c.header("Cache-Control", "no-store");
      return c.json(issued, 201);
    } catch (err) {
      return refusal(c, err);
    }
  });

  return app;
}
