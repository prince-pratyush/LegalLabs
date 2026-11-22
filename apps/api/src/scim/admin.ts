import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";
import { audit } from "../auth/audit.js";
import type { Client, Principal } from "../auth/auth.js";
import { asApp, RLS_REFUSED } from "../db.js";

/** What an admin does with SCIM: switch it on, issue tokens, resume after a pause, map roles. */

export class AdminRefused extends Error {
  constructor(
    readonly status: 400 | 403 | 404,
    message: string,
  ) {
    super(message);
  }
}

const SERVICE_EMAIL = "scim-provisioner@scim.invalid";
const sha256 = (t: string) => createHash("sha256").update(t).digest();

const refuse = (err: unknown): never => {
  const code = (err as { code?: string }).code;
  if (code === RLS_REFUSED) throw new AdminRefused(403, (err as Error).message);
  if (code === "22023") throw new AdminRefused(400, (err as Error).message);
  throw err;
};

export function createScimAdmin(pool: pg.Pool) {
  const as = <T>(p: Principal, work: (db: pg.PoolClient) => Promise<T>) =>
    asApp(pool, { userId: p.userId, workspaceId: p.workspaceId }, work);

  const need = async (db: pg.PoolClient, permission: string) => {
    const { rows } = await db.query<{ ok: boolean }>("select core.has_permission($1) as ok", [
      permission,
    ]);
    if (!rows[0]?.ok) throw new AdminRefused(403, `Needs the ${permission} permission.`);
  };

  return {
    async status(p: Principal) {
      return as(p, async (db) => {
        await need(db, "admin.users");
        const ws = await db.query<{ settings: Record<string, unknown> }>(
          "select settings from core.workspace where id = $1",
          [p.workspaceId],
        );
        const guard = await db.query(
          "select paused_at, paused_count, paused_population from scim.guard",
        );
        const tokens = await db.query(
          `select t.id, t.name, t.created_at, t.expires_at, t.last_used_at, t.revoked_at
             from core.api_token t join core."user" u on u.workspace_id = t.workspace_id and u.id = t.principal_id
            where u.kind = 'service' and 'scim' = any (t.scopes) order by t.created_at desc`,
        );
        const settings = ws.rows[0]?.settings ?? {};
        return {
          enabled: settings.scim_enabled === true,
          ip_allowlist: (settings.scim_ip_allowlist as string[] | undefined) ?? [],
          paused: guard.rows[0]?.paused_at != null,
          paused_count: guard.rows[0]?.paused_count ?? null,
          tokens: tokens.rows,
        };
      });
    },

    async configure(
      p: Principal,
      client: Client,
      input: { enabled: boolean; ipAllowlist?: string[] },
    ) {
      await as(p, async (db) => {
        await need(db, "admin.config");
        if (input.ipAllowlist) {
          try {
            for (const entry of input.ipAllowlist) await db.query("select $1::inet", [entry]);
          } catch {
            throw new AdminRefused(400, "The IP allow-list holds an address that is not valid.");
          }
        }
        await db.query(
          `update core.workspace
              set settings = settings || jsonb_build_object('scim_enabled', $2::boolean)
                  || case when $3::jsonb is null then '{}'::jsonb
                          else jsonb_build_object('scim_ip_allowlist', $3::jsonb) end
            where id = $1`,
          [
            p.workspaceId,
            input.enabled,
            input.ipAllowlist ? JSON.stringify(input.ipAllowlist) : null,
          ],
        );
        await audit(db, p, client, "settings.changed", "workspace", p.workspaceId, {
          key: "scim_enabled",
          value: input.enabled,
          ip_allowlist: input.ipAllowlist?.length ?? null,
        });
      });
    },

    /** The secret is returned once and never stored: only its hash is. */
    async createToken(p: Principal, client: Client, input: { name: string; days?: number }) {
      const days = Math.min(365, Math.max(1, Math.trunc(input.days ?? 180)));
      return as(p, async (db) => {
        await need(db, "admin.users");
        const on = await db.query<{ on: boolean }>(
          "select coalesce(settings ->> 'scim_enabled', 'false') = 'true' as on from core.workspace where id = $1",
          [p.workspaceId],
        );
        if (!on.rows[0]?.on) throw new AdminRefused(400, "Turn SCIM on before issuing a token.");
        let principal = (
          await db.query<{ id: string }>(
            `select id from core."user" where workspace_id = $1 and kind = 'service' and email = $2`,
            [p.workspaceId, SERVICE_EMAIL],
          )
        ).rows[0]?.id;
        if (!principal) {
          principal = (
            await db.query<{ id: string }>(
              `insert into core."user" (workspace_id, email, name, kind, status)
               values ($1, $2, 'SCIM provisioner', 'service', 'active') returning id`,
              [p.workspaceId, SERVICE_EMAIL],
            )
          ).rows[0]?.id;
        }
        const token = `scim_${randomBytes(32).toString("base64url")}`;
        const row = await db.query<{ id: string; expires_at: Date }>(
          `insert into core.api_token (workspace_id, principal_id, name, token_hash, scopes, expires_at)
           values ($1, $2, $3, $4, '{scim}', now() + make_interval(days => $5))
           returning id, expires_at`,
          [p.workspaceId, principal, input.name.slice(0, 200) || "SCIM", sha256(token), days],
        );
        const id = row.rows[0]?.id ?? "";
        await audit(db, p, client, "token.created", "api_token", id, { scope: "scim", days });
        return { id, token, expires_at: row.rows[0]?.expires_at };
      });
    },

    async revokeToken(p: Principal, client: Client, tokenId: string) {
      await as(p, async (db) => {
        await need(db, "admin.users");
        const r = await db.query(
          `update core.api_token set revoked_at = now()
            where id = $1 and revoked_at is null and 'scim' = any (scopes)`,
          [tokenId],
        );
        if (r.rowCount === 0) throw new AdminRefused(404, "No such token.");
        await audit(db, p, client, "token.revoked", "api_token", tokenId);
      });
    },

    async resume(p: Principal, client: Client) {
      return as(p, async (db) => {
        const r = await db
          .query<{ resumed: boolean }>("select scim.resume_provisioning() as resumed")
          .catch(refuse);
        await audit(db, p, client, "settings.changed", "workspace", p.workspaceId, {
          key: "scim_resume",
        });
        return r.rows[0]?.resumed ?? false;
      });
    },

    async mappings(p: Principal) {
      return as(p, async (db) => {
        await need(db, "admin.users");
        return (
          await db.query(
            `select m.id, m.group_id, g.name as group_name, m.role_id, r.name as role_name, m.priority,
                    m.state, m.needs_confirmation, m.requested_by, m.confirmed_by
               from scim.group_role m
               join core."group" g on g.workspace_id = m.workspace_id and g.id = m.group_id
               join core.role r on r.workspace_id = m.workspace_id and r.id = m.role_id
              order by g.name`,
          )
        ).rows;
      });
    },

    async requestMapping(
      p: Principal,
      client: Client,
      input: { groupId: string; roleId: string; priority?: number },
    ) {
      return as(p, async (db) => {
        const r = await db
          .query<{ id: string }>("select scim.request_group_role($1, $2, $3) as id", [
            input.groupId,
            input.roleId,
            input.priority ?? 100,
          ])
          .catch(refuse);
        const id = r.rows[0]?.id ?? "";
        await audit(db, p, client, "permission.granted", "group_role", id, {
          group_id: input.groupId,
          role_id: input.roleId,
        });
        return id;
      });
    },

    async confirmMapping(p: Principal, client: Client, id: string) {
      await as(p, async (db) => {
        await db.query("select scim.confirm_group_role($1)", [id]).catch(refuse);
        await audit(db, p, client, "permission.granted", "group_role", id, { confirmed: true });
      });
    },

    async removeMapping(p: Principal, client: Client, id: string) {
      await as(p, async (db) => {
        await db.query("select scim.remove_group_role($1)", [id]).catch(refuse);
        await audit(db, p, client, "permission.revoked", "group_role", id);
      });
    },
  };
}

export type ScimAdmin = ReturnType<typeof createScimAdmin>;
