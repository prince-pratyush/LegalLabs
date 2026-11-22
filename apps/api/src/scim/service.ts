import { createHash } from "node:crypto";
import type pg from "pg";
import { asApp } from "../db.js";
import { badRequest, ScimError } from "./errors.js";
import { type Filter, matches, parseFilter, resolvePath, simpleEquality } from "./filter.js";
import { applyPatch, normalizeBody } from "./patch.js";
import { noWebhook, type ScimWebhook } from "./ports.js";
import {
  etagOf,
  fromUserDoc,
  type GroupRow,
  project,
  toGroupDoc,
  toUserDoc,
  type UserRow,
} from "./resources.js";
import { groupResource, LIST_URN, userResource } from "./schemas.js";

type Doc = Record<string, unknown>;

export interface ScimContext {
  tokenId: string;
  principalId: string;
  workspaceId: string;
  ip: string | null;
  userAgent: string | null;
  /** https://host/scim/v2, for Location and meta.location. */
  base: string;
}

export interface ListQuery {
  filter?: string;
  startIndex?: string;
  count?: string;
  sortBy?: string;
  sortOrder?: string;
  attributes?: string;
  excludedAttributes?: string;
}

export interface Found {
  doc: Doc;
  etag: string;
}

export const MAX_COUNT = 200;
const DEFAULT_COUNT = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha256 = (t: string) => createHash("sha256").update(t).digest();

const USER_SELECT = `
  select u.id, u.email, u.name, u.status, u.profile, u.created_at, u.updated_at,
         u.scim_external_id, u.scim_version,
         coalesce((select json_agg(json_build_object('id', g.id, 'name', g.name) order by g.name)
                     from core.group_member m
                     join core."group" g on g.workspace_id = m.workspace_id and g.id = m.group_id
                    where m.workspace_id = u.workspace_id and m.user_id = u.id), '[]') as groups
    from core."user" u
   where u.kind = 'member' and u.scim_deleted_at is null`;

const GROUP_SELECT = `
  select g.id, g.name, g.scim_group_id, g.created_at, g.updated_at, g.scim_version,
         coalesce((select json_agg(json_build_object('id', u.id, 'email', u.email) order by u.email)
                     from core.group_member m
                     join core."user" u on u.workspace_id = m.workspace_id and u.id = m.user_id
                    where m.workspace_id = g.workspace_id and m.group_id = g.id), '[]') as members
    from core."group" g
   where true`;

const notFound = (what: string) => new ScimError(404, undefined, `${what} not found.`);

function checkVersion(ifMatch: string | undefined, version: number) {
  if (ifMatch === undefined || ifMatch === "*") return;
  const have = etagOf(version);
  const given = ifMatch.split(",").map((s) => s.trim().replace(/^W\//, ""));
  if (!given.includes(have.replace(/^W\//, ""))) {
    throw new ScimError(412, "invalidVers", "The resource changed since you last read it.");
  }
}

function isUnique(err: unknown) {
  return (err as { code?: string })?.code === "23505";
}

export type Tripped = { tripped: { events: number; population: number } };
const wasTripped = (r: unknown): r is Tripped =>
  typeof r === "object" && r !== null && "tripped" in r;

export function createScim(pool: pg.Pool, opts: { webhook?: ScimWebhook } = {}) {
  const webhook = opts.webhook ?? noWebhook;
  const NOBODY = { userId: null, workspaceId: null };

  const run = <T>(ctx: ScimContext, work: (db: pg.PoolClient) => Promise<T>) =>
    asApp(pool, { userId: ctx.principalId, workspaceId: ctx.workspaceId }, work);

  const audit = (
    db: pg.PoolClient,
    ctx: ScimContext,
    action: string,
    objectType: string,
    objectId: string,
    details: object = {},
  ) =>
    db.query("select admin.append_audit_event($1, 'service', $2, $3, $4, $5, $6, null)", [
      action,
      ctx.principalId,
      objectType,
      objectId,
      JSON.stringify(details),
      ctx.ip,
    ]);

  async function authenticate(
    token: string,
    ip: string | null,
    route: string,
  ): Promise<Omit<ScimContext, "base" | "userAgent">> {
    const row = await asApp(pool, NOBODY, async (db) => {
      const { rows } = await db.query<{
        token_id: string;
        principal_id: string;
        workspace_id: string;
        scopes: string[];
        enabled: boolean;
        ip_allowed: boolean;
      }>("select * from scim.authenticate($1, $2)", [sha256(token), ip]);
      return rows[0];
    });
    if (!row) throw new ScimError(401, undefined, "Invalid or expired token.");
    const deny = async (reason: string, message: string) => {
      await asApp(pool, { userId: null, workspaceId: row.workspace_id }, (db) =>
        db.query(
          "select admin.append_audit_event('token.used_denied', 'system', null, 'api_token', $1, $2, $3, null)",
          [row.token_id, JSON.stringify({ reason, route }), ip],
        ),
      );
      throw new ScimError(403, undefined, message);
    };
    // Scope is checked first, so a token meant for something else learns nothing else.
    if (!row.scopes.includes("scim")) await deny("scope", "This token is not for SCIM.");
    if (!row.enabled) await deny("disabled", "SCIM is not enabled for this workspace.");
    if (!row.ip_allowed) await deny("ip", "This address is not allowed.");
    const ctx = {
      tokenId: row.token_id,
      principalId: row.principal_id,
      workspaceId: row.workspace_id,
      ip,
    };
    await run({ ...ctx, userAgent: null, base: "" }, (db) =>
      db.query(
        `update core.api_token set last_used_at = now()
          where id = $1 and (last_used_at is null or last_used_at < now() - interval '1 minute')`,
        [ctx.tokenId],
      ),
    );
    return ctx;
  }

  /** Filters, sorts and pages an in-memory set, then trims each document. */
  function list(docs: Doc[], q: ListQuery, filterDb: boolean): Doc {
    let filter: Filter | undefined;
    if (q.filter !== undefined && q.filter !== "") filter = parseFilter(q.filter);
    let out = filter && !filterDb ? docs.filter((d) => matches(filter as Filter, d)) : docs;
    if (q.sortBy) {
      const path = q.sortBy.split(".");
      const dir = (q.sortOrder ?? "ascending").toLowerCase() === "descending" ? -1 : 1;
      const key = (d: Doc) => {
        const v = resolvePath(d, { parts: path })[0];
        return (typeof v === "string" ? v.toLowerCase() : v) as string | number | undefined;
      };
      out = [...out].sort((a, b) => {
        const x = key(a);
        const y = key(b);
        // Unset values sort last either way, as RFC 7644 section 3.4.2.3 asks.
        if (x === undefined) return y === undefined ? 0 : 1;
        if (y === undefined) return -1;
        return (x < y ? -1 : x > y ? 1 : 0) * dir;
      });
    }
    const startIndex = Math.max(1, Number.parseInt(q.startIndex ?? "1", 10) || 1);
    const parsed = q.count === undefined ? DEFAULT_COUNT : Number.parseInt(q.count, 10);
    const count = Math.min(MAX_COUNT, Math.max(0, Number.isNaN(parsed) ? DEFAULT_COUNT : parsed));
    const page = out.slice(startIndex - 1, startIndex - 1 + count);
    return {
      schemas: [LIST_URN],
      totalResults: out.length,
      startIndex,
      itemsPerPage: page.length,
      Resources: page.map((d) => project(d, q.attributes, q.excludedAttributes)),
    };
  }

  async function trip(ctx: ScimContext, t: Tripped["tripped"]): Promise<never> {
    await webhook
      .notify({
        type: "scim.mass_delete_paused",
        workspaceId: ctx.workspaceId,
        count: t.events,
        population: t.population,
      })
      .catch((err) => console.error(`scim webhook failed: ${String(err)}`));
    throw new ScimError(
      403,
      undefined,
      "Too many people were removed within an hour. Provisioning is paused until an admin confirms.",
    );
  }

  const finish = async <T>(ctx: ScimContext, work: Promise<T | Tripped>): Promise<T> => {
    const r = await work;
    if (wasTripped(r)) return trip(ctx, r.tripped);
    return r;
  };

  // ---- users -------------------------------------------------------------------------------

  const loadUser = async (db: pg.PoolClient, id: string, lock = false) => {
    if (!UUID.test(id)) return undefined;
    const { rows } = await db.query<UserRow>(
      `${USER_SELECT} and u.id = $1${lock ? " for update of u" : ""}`,
      [id],
    );
    return rows[0];
  };

  async function deprovision(
    db: pg.PoolClient,
    ctx: ScimContext,
    userId: string,
    via: "active" | "delete",
  ): Promise<Tripped | null> {
    const { rows } = await db.query<{ outcome: string; events: number; population: number }>(
      "select * from scim.record_deprovision($1, $2)",
      [userId, via],
    );
    const r = rows[0];
    if (r?.outcome === "paused") {
      throw new ScimError(403, undefined, "Provisioning is paused until an admin confirms.");
    }
    if (r?.outcome === "tripped") {
      await audit(db, ctx, "scim.mass_delete_paused", "workspace", ctx.workspaceId, {
        count: r.events,
        population: r.population,
        via,
      });
      return { tripped: { events: r.events, population: r.population } };
    }
    await db.query("select * from scim.revoke_user_access($1)", [userId]);
    return null;
  }

  async function commitUser(
    db: pg.PoolClient,
    ctx: ScimContext,
    row: UserRow,
    next: Doc,
  ): Promise<Found | Tripped> {
    const cols = fromUserDoc(next, row.profile);
    if (!cols.email.includes("@")) throw badRequest("invalidValue", "userName must be an email.");
    let status = row.status;
    if (cols.active === false && (status === "active" || status === "invited")) {
      const t = await deprovision(db, ctx, row.id, "active");
      if (t) return t;
      status = "deprovisioned";
    } else if (cols.active === true && (status === "deprovisioned" || status === "invited")) {
      status = "active";
    }
    try {
      await db.query(
        `update core."user" set email = $2, name = $3, status = $4, profile = $5,
                scim_external_id = $6 where id = $1`,
        [row.id, cols.email, cols.name, status, JSON.stringify(cols.profile), cols.externalId],
      );
    } catch (err) {
      if (isUnique(err)) throw new ScimError(409, "uniqueness", "userName already exists.");
      throw err;
    }
    const deactivated = status === "deprovisioned" && row.status !== "deprovisioned";
    await audit(
      db,
      ctx,
      deactivated ? "scim.user_deactivated" : "scim.user_updated",
      "user",
      row.id,
      {
        via: deactivated ? "active" : "update",
      },
    );
    return reread(db, ctx, row.id);
  }

  async function reread(db: pg.PoolClient, ctx: ScimContext, id: string): Promise<Found> {
    const row = await loadUser(db, id);
    if (!row) throw notFound("User");
    return { doc: toUserDoc(row, ctx.base), etag: etagOf(row.scim_version) };
  }

  const users = {
    async list(ctx: ScimContext, q: ListQuery) {
      return run(ctx, async (db) => {
        const filter = q.filter ? parseFilter(q.filter) : undefined;
        const eq = filter ? simpleEquality(filter) : null;
        let rows: UserRow[];
        if (eq && eq.attr !== "id") {
          // The hot path of every provider: look one person up before creating them.
          const column =
            eq.attr === "userName" ? "lower(u.email) = lower($1)" : "u.scim_external_id = $1";
          rows = (await db.query<UserRow>(`${USER_SELECT} and ${column}`, [eq.value])).rows;
        } else if (eq && UUID.test(eq.value)) {
          rows = (await db.query<UserRow>(`${USER_SELECT} and u.id = $1`, [eq.value])).rows;
        } else if (eq) {
          rows = [];
        } else {
          rows = (await db.query<UserRow>(`${USER_SELECT} order by lower(u.email)`)).rows;
        }
        return list(
          rows.map((r) => toUserDoc(r, ctx.base)),
          q,
          eq !== null,
        );
      });
    },

    async get(ctx: ScimContext, id: string) {
      return run(ctx, (db) => reread(db, ctx, id));
    },

    async create(ctx: ScimContext, body: unknown): Promise<Found> {
      const doc = normalizeBody(userResource, body);
      const cols = fromUserDoc(doc, {});
      if (!cols.email.includes("@")) throw badRequest("invalidValue", "userName must be an email.");
      const status = cols.active === false ? "deprovisioned" : "active";
      return run(ctx, async (db) => {
        // A person SCIM deleted earlier comes back as the same row, so their history stays whole.
        const old = await db.query<{ id: string }>(
          `select id from core."user"
            where lower(email) = lower($1) and kind = 'member' and scim_deleted_at is not null`,
          [cols.email],
        );
        let id = old.rows[0]?.id;
        try {
          if (id) {
            await db.query(
              `update core."user" set email = $2, name = $3, status = $4, profile = $5,
                      scim_external_id = $6, scim_deleted_at = null, scim_managed = true
                where id = $1`,
              [id, cols.email, cols.name, status, JSON.stringify(cols.profile), cols.externalId],
            );
          } else {
            const ins = await db.query<{ id: string }>(
              `insert into core."user" (workspace_id, email, name, status, profile, scim_external_id, scim_managed)
               values ($1, $2, $3, $4, $5, $6, true) returning id`,
              [
                ctx.workspaceId,
                cols.email,
                cols.name,
                status,
                JSON.stringify(cols.profile),
                cols.externalId,
              ],
            );
            id = ins.rows[0]?.id;
          }
        } catch (err) {
          if (isUnique(err)) throw new ScimError(409, "uniqueness", "userName already exists.");
          throw err;
        }
        if (!id) throw new Error("user insert returned no id");
        await audit(db, ctx, "scim.user_created", "user", id, { active: status === "active" });
        return reread(db, ctx, id);
      });
    },

    async replace(ctx: ScimContext, id: string, body: unknown, ifMatch?: string) {
      const next = normalizeBody(userResource, body);
      return finish(
        ctx,
        run(ctx, async (db) => {
          const row = await loadUser(db, id, true);
          if (!row) throw notFound("User");
          checkVersion(ifMatch, row.scim_version);
          return commitUser(db, ctx, row, next);
        }),
      );
    },

    async patch(ctx: ScimContext, id: string, body: unknown, ifMatch?: string) {
      return finish(
        ctx,
        run(ctx, async (db) => {
          const row = await loadUser(db, id, true);
          if (!row) throw notFound("User");
          checkVersion(ifMatch, row.scim_version);
          const next = applyPatch(userResource, toUserDoc(row, ctx.base), body);
          return commitUser(db, ctx, row, next);
        }),
      );
    },

    async remove(ctx: ScimContext, id: string, ifMatch?: string): Promise<void> {
      await finish(
        ctx,
        run(ctx, async (db) => {
          const row = await loadUser(db, id, true);
          if (!row) throw notFound("User");
          checkVersion(ifMatch, row.scim_version);
          if (row.status !== "deprovisioned") {
            const t = await deprovision(db, ctx, id, "delete");
            if (t) return t;
          }
          const gone = await db.query<{ group_id: string }>(
            "delete from core.group_member where user_id = $1 returning group_id",
            [id],
          );
          await db.query(
            `update core."user" set status = 'deprovisioned', scim_deleted_at = now() where id = $1`,
            [id],
          );
          if (gone.rowCount) await db.query("select scim.apply_group_roles($1)", [id]);
          await audit(db, ctx, "scim.user_deactivated", "user", id, { via: "delete" });
          return null;
        }),
      );
    },
  };

  // ---- groups ------------------------------------------------------------------------------

  const loadGroup = async (db: pg.PoolClient, id: string, lock = false) => {
    if (!UUID.test(id)) return undefined;
    const { rows } = await db.query<GroupRow>(
      `${GROUP_SELECT} and g.id = $1${lock ? " for update of g" : ""}`,
      [id],
    );
    return rows[0];
  };

  const memberIds = (doc: Doc): string[] => {
    const raw = (doc.members ?? []) as { value?: string }[];
    const ids = raw.map((m) => m.value ?? "");
    if (ids.some((v) => !UUID.test(v))) {
      throw badRequest("invalidValue", "A member's value must be a user id.");
    }
    return [...new Set(ids.map((v) => v.toLowerCase()))];
  };

  async function setMembers(db: pg.PoolClient, ctx: ScimContext, group: string, want: string[]) {
    if (want.length > 0) {
      const found = await db.query<{ id: string }>(
        `select id from core."user"
          where id = any($1::uuid[]) and kind = 'member' and scim_deleted_at is null`,
        [want],
      );
      if (found.rowCount !== want.length) {
        throw badRequest("invalidValue", "A member is not a known user.");
      }
    }
    const have = (
      await db.query<{ user_id: string }>(
        "select user_id from core.group_member where group_id = $1",
        [group],
      )
    ).rows.map((r) => r.user_id);
    const add = want.filter((id) => !have.includes(id));
    const drop = have.filter((id) => !want.includes(id));
    if (add.length > 0) {
      await db.query(
        `insert into core.group_member (workspace_id, group_id, user_id)
         select $1, $2, unnest($3::uuid[])`,
        [ctx.workspaceId, group, add],
      );
    }
    if (drop.length > 0) {
      await db.query(
        "delete from core.group_member where group_id = $1 and user_id = any($2::uuid[])",
        [group, drop],
      );
    }
    for (const id of [...add, ...drop]) await db.query("select scim.apply_group_roles($1)", [id]);
    return { added: add.length, removed: drop.length };
  }

  const groupFound = async (db: pg.PoolClient, ctx: ScimContext, id: string): Promise<Found> => {
    const row = await loadGroup(db, id);
    if (!row) throw notFound("Group");
    return { doc: toGroupDoc(row, ctx.base), etag: etagOf(row.scim_version) };
  };

  async function writeGroup(
    db: pg.PoolClient,
    ctx: ScimContext,
    row: GroupRow,
    next: Doc,
    op: string,
  ) {
    const name = String(next.displayName ?? "");
    const external =
      typeof next.externalId === "string" && next.externalId ? next.externalId : null;
    try {
      await db.query(`update core."group" set name = $2, scim_group_id = $3 where id = $1`, [
        row.id,
        name,
        external,
      ]);
    } catch (err) {
      if (isUnique(err)) throw new ScimError(409, "uniqueness", "displayName already exists.");
      throw err;
    }
    const changed = await setMembers(db, ctx, row.id, memberIds(next));
    await audit(db, ctx, "scim.group_synced", "group", row.id, { op, ...changed });
    return groupFound(db, ctx, row.id);
  }

  const groups = {
    async list(ctx: ScimContext, q: ListQuery) {
      return run(ctx, async (db) => {
        const rows = (await db.query<GroupRow>(`${GROUP_SELECT} order by lower(g.name)`)).rows;
        return list(
          rows.map((r) => toGroupDoc(r, ctx.base)),
          q,
          false,
        );
      });
    },

    async get(ctx: ScimContext, id: string) {
      return run(ctx, (db) => groupFound(db, ctx, id));
    },

    async create(ctx: ScimContext, body: unknown): Promise<Found> {
      const doc = normalizeBody(groupResource, body);
      const ids = memberIds(doc);
      return run(ctx, async (db) => {
        let id: string | undefined;
        try {
          const ins = await db.query<{ id: string }>(
            `insert into core."group" (workspace_id, name, scim_group_id) values ($1, $2, $3) returning id`,
            [
              ctx.workspaceId,
              String(doc.displayName),
              typeof doc.externalId === "string" ? doc.externalId : null,
            ],
          );
          id = ins.rows[0]?.id;
        } catch (err) {
          if (isUnique(err)) throw new ScimError(409, "uniqueness", "displayName already exists.");
          throw err;
        }
        if (!id) throw new Error("group insert returned no id");
        const changed = await setMembers(db, ctx, id, ids);
        await audit(db, ctx, "scim.group_synced", "group", id, { op: "create", ...changed });
        return groupFound(db, ctx, id);
      });
    },

    async replace(ctx: ScimContext, id: string, body: unknown, ifMatch?: string) {
      const next = normalizeBody(groupResource, body);
      return run(ctx, async (db) => {
        const row = await loadGroup(db, id, true);
        if (!row) throw notFound("Group");
        checkVersion(ifMatch, row.scim_version);
        return writeGroup(db, ctx, row, next, "replace");
      });
    },

    async patch(ctx: ScimContext, id: string, body: unknown, ifMatch?: string) {
      return run(ctx, async (db) => {
        const row = await loadGroup(db, id, true);
        if (!row) throw notFound("Group");
        checkVersion(ifMatch, row.scim_version);
        const next = applyPatch(groupResource, toGroupDoc(row, ctx.base), body);
        return writeGroup(db, ctx, row, next, "patch");
      });
    },

    async remove(ctx: ScimContext, id: string, ifMatch?: string): Promise<void> {
      await run(ctx, async (db) => {
        const row = await loadGroup(db, id, true);
        if (!row) throw notFound("Group");
        checkVersion(ifMatch, row.scim_version);
        const members = row.members.map((m) => m.id);
        try {
          await db.query(`delete from core."group" where id = $1`, [id]);
        } catch (err) {
          if ((err as { code?: string }).code === "23503") {
            throw new ScimError(409, undefined, "The group is still in use.");
          }
          throw err;
        }
        for (const m of members) await db.query("select scim.apply_group_roles($1)", [m]);
        await audit(db, ctx, "scim.group_synced", "group", id, {
          op: "delete",
          removed: members.length,
        });
      });
    },
  };

  return { authenticate, users, groups };
}

export type Scim = ReturnType<typeof createScim>;
