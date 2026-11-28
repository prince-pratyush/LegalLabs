import { createHash, randomBytes } from "node:crypto";
import {
  DEFAULT_USER_PERMISSIONS,
  type Group,
  INVITE_HOURS,
  type Invitation,
  type InviteResult,
  type InviteUsers,
  isAdminPermission,
  MAX_CUSTOM_ROLES,
  MAX_INVITES,
  type ManagedUser,
  type Role,
  type RoleInput,
  type UserDirectory,
  type UserPatch,
  type UserStatus,
} from "@legallabs/contracts";
import type pg from "pg";
import { z } from "zod";
import { audit } from "../auth/audit.js";
import { type Client, type Principal, uaHash } from "../auth/auth.js";
import { hashPassword } from "../auth/password.js";
import { asApp, RLS_REFUSED } from "../db.js";
import type { EmailProvider } from "../notifications/email-port.js";

/** Inviting people and changing what they may do (ADM-001). */

export class UsersRefused extends Error {
  constructor(
    readonly status: 403 | 404 | 409 | 422,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const forbidden = () =>
  new UsersRefused(403, "FORBIDDEN", "You can't give or change permissions you don't hold.");
const notFound = () => new UsersRefused(404, "NOT_FOUND", "That wasn't found.");
const scimOwned = () =>
  new UsersRefused(409, "SCIM_MANAGED", "Your identity provider manages this. Change it there.");

/** Turns what the database refused into what to tell the administrator. */
function refusal(err: unknown): never {
  const { code, message } = err as { code?: string; message?: string };
  if (message === "LAST_ADMIN") {
    throw new UsersRefused(409, "LAST_ADMIN", "A workspace needs at least one administrator.");
  }
  if (message === "SCIM_MANAGED") throw scimOwned();
  if (code === RLS_REFUSED) throw forbidden();
  throw err;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest();
const emailShape = z.email().max(320);

export interface UsersOptions {
  /** The public address of the web app, for invitation links. */
  baseUrl: string;
  /** Left out, a link is shown once to the administrator instead of being mailed. */
  mail?: EmailProvider;
}

export function createUsers(pool: pg.Pool, opts: UsersOptions) {
  const base = opts.baseUrl.replace(/\/$/, "");

  const as = <T>(p: Principal, work: (db: pg.PoolClient) => Promise<T>) =>
    asApp(pool, { userId: p.userId, workspaceId: p.workspaceId }, work).catch(refusal);

  const check = async (db: pg.PoolClient, sql: string, params: unknown[]) =>
    (await db.query<{ ok: boolean }>(sql, params)).rows[0]?.ok === true;

  const can = (db: pg.PoolClient, permission: string) =>
    check(db, "select core.has_permission($1) as ok", [permission]);

  const need = async (db: pg.PoolClient) => {
    if (!(await can(db, "admin.users"))) {
      throw new UsersRefused(403, "FORBIDDEN", "Needs the admin.users permission.");
    }
  };

  const holds = (db: pg.PoolClient, permissions: string[]) =>
    check(db, "select core.holds_all($1) as ok", [permissions]);

  const workspace = async (db: pg.PoolClient, p: Principal) => {
    const { rows } = await db.query<{ slug: string; scim: boolean; sso: boolean }>(
      `select w.slug, coalesce(w.settings ->> 'scim_enabled' = 'true', false) as scim,
              exists (select 1 from core.oidc_login_config(w.slug)) as sso
         from core.workspace w where w.id = $1`,
      [p.workspaceId],
    );
    return rows[0] ?? { slug: "", scim: false, sso: false };
  };

  const roleOf = async (db: pg.PoolClient, p: Principal, id: string) => {
    const { rows } = await db.query<{ id: string; permissions: string[] }>(
      "select id, permissions from core.role where id = $1 and workspace_id = $2",
      [id, p.workspaceId],
    );
    const role = rows[0];
    if (!role) throw notFound();
    return { ...role, admin: role.permissions.some(isAdminPermission) };
  };

  // Groups an identity provider owns, or whose members get a role from it, are not ours to edit.
  const GROUPS = `
    select g.id, g.name,
           g.scim_group_id is null
             and not exists (select 1 from scim.group_role m where m.group_id = g.id) as manageable
      from core."group" g
     where g.workspace_id = $1 and g.kind = 'standard'
     order by lower(g.name)`;

  const manageableGroups = async (db: pg.PoolClient, p: Principal, ids: string[]) => {
    const { rows } = await db.query<Group>(GROUPS, [p.workspaceId]);
    const mine = new Set(rows.filter((g) => g.manageable).map((g) => g.id));
    if (!ids.every((id) => mine.has(id))) throw notFound();
    return mine;
  };

  const USERS = `
    select u.id, u.email, u.name, u.status, u.role_id, r.name as role_name, u.role_from_group,
           case when u.scim_managed then 'scim' else 'manual' end as source,
           array(select m.group_id from core.group_member m
                  where m.workspace_id = u.workspace_id and m.user_id = u.id)::text[] as group_ids
      from core."user" u
      left join core.role r on r.workspace_id = u.workspace_id and r.id = u.role_id
     where u.workspace_id = $1 and u.kind = 'member'`;

  const linkFor = (token: string) => `${base}/#/auth/invite?token=${token}`;

  async function deliver(
    who: { id: string; email: string; token: string | null },
    slug: string,
  ): Promise<Invitation> {
    const { id, email, token } = who;
    const link = token ? linkFor(token) : null;
    if (!opts.mail) {
      return link ? { id, email, delivery: "link", link } : { id, email, delivery: "sso" };
    }
    try {
      await opts.mail.send({
        to: { email, name: "" },
        subject: "You have been invited to LegalLabs",
        text: link
          ? `You have been added to the LegalLabs workspace "${slug}".\n\n` +
            `Set your password with this link. It works once, for ${INVITE_HOURS} hours:\n\n` +
            `${link}\n\nIf you weren't expecting this, you can ignore it.\n`
          : `You have been added to the LegalLabs workspace "${slug}".\n\n` +
            `Sign in with single sign-on at ${base}\n`,
        auto: true,
      });
      return { id, email, delivery: token ? "email" : "sso" };
    } catch {
      // Not shown to the administrator instead: a link they never expected to hold stays unsent.
      return { id, email, delivery: "failed" };
    }
  }

  /** Makes the link for someone invited; null where they will use single sign-on. */
  async function issue(db: pg.PoolClient, userId: string, sso: boolean) {
    if (sso) return null;
    const token = randomBytes(32).toString("base64url");
    await db.query("select core.create_invite($1, $2, $3)", [
      userId,
      sha256(token),
      INVITE_HOURS * 3600,
    ]);
    return token;
  }

  /** Ends what a person holds, so a change of access applies to what is already open. */
  async function endAccess(db: pg.PoolClient, p: Principal, userId: string, client: Client) {
    const sessions = await db.query(
      `update core.session set revoked_at = now()
        where workspace_id = $1 and user_id = $2 and revoked_at is null`,
      [p.workspaceId, userId],
    );
    await db.query(
      `update core.api_token set revoked_at = now()
        where workspace_id = $1 and principal_id = $2 and revoked_at is null`,
      [p.workspaceId, userId],
    );
    await audit(db, p, client, "session.revoked", "user", userId, { sessions: sessions.rowCount });
  }

  const one = async (db: pg.PoolClient, p: Principal, id: string) => {
    const { rows } = await db.query<Omit<ManagedUser, "is_self">>(`${USERS} and u.id = $2`, [
      p.workspaceId,
      id,
    ]);
    const row = rows[0];
    if (!row) throw notFound();
    return { ...row, is_self: row.id === p.userId };
  };

  return {
    async list(p: Principal): Promise<UserDirectory> {
      return as(p, async (db) => {
        await need(db);
        const ws = await workspace(db, p);
        const { rows } = await db.query<Omit<ManagedUser, "is_self">>(
          `${USERS} order by lower(u.email)`,
          [p.workspaceId],
        );
        return {
          items: rows.map((r) => ({ ...r, is_self: r.id === p.userId })),
          scim_enabled: ws.scim,
          sso_enabled: ws.sso,
          mail_configured: opts.mail !== undefined,
        };
      });
    },

    async roles(p: Principal): Promise<Role[]> {
      return as(p, async (db) => {
        if (!(await can(db, "admin.users")) && !(await can(db, "admin.config"))) {
          throw new UsersRefused(403, "FORBIDDEN", "Needs the admin.users permission.");
        }
        // Workspaces made before there was a User role get it when someone first looks.
        await db.query(
          `insert into core.role (workspace_id, name, builtin, permissions)
           select $1, 'User', true, $2
            where core.has_permission('admin.users') and core.holds_all($2)
           on conflict (workspace_id, name) do nothing`,
          [p.workspaceId, DEFAULT_USER_PERMISSIONS],
        );
        const { rows } = await db.query<Omit<Role, "admin">>(
          `select id, name, builtin, permissions from core.role
            where workspace_id = $1 order by not builtin, lower(name)`,
          [p.workspaceId],
        );
        return rows.map((r) => ({ ...r, admin: r.permissions.some(isAdminPermission) }));
      });
    },

    async createRole(p: Principal, input: RoleInput, client: Client): Promise<Role> {
      return as(p, async (db) => {
        await need(db);
        await db.query("select pg_advisory_xact_lock(hashtextextended('roles:' || $1, 0))", [
          p.workspaceId,
        ]);
        const { rows: count } = await db.query<{ n: number }>(
          `select count(*)::int as n from core.role where workspace_id = $1 and not builtin`,
          [p.workspaceId],
        );
        if ((count[0]?.n ?? 0) >= MAX_CUSTOM_ROLES) {
          throw new UsersRefused(
            422,
            "ROLE_LIMIT",
            `At most ${MAX_CUSTOM_ROLES} custom roles are allowed.`,
          );
        }
        const permissions = [...new Set(input.permissions)];
        if (!(await holds(db, permissions))) throw forbidden();
        const { rows } = await db.query<Omit<Role, "admin">>(
          `insert into core.role (workspace_id, name, permissions) values ($1, $2, $3)
           on conflict (workspace_id, name) do nothing
           returning id, name, builtin, permissions`,
          [p.workspaceId, input.name, permissions],
        );
        const role = rows[0];
        if (!role) throw new UsersRefused(409, "DUPLICATE_NAME", "That name is already used.");
        await audit(db, p, client, "role.created", "role", role.id, { permissions });
        return { ...role, admin: role.permissions.some(isAdminPermission) };
      });
    },

    async groups(p: Principal): Promise<Group[]> {
      return as(p, async (db) => {
        await need(db);
        return (await db.query<Group>(GROUPS, [p.workspaceId])).rows;
      });
    },

    async createGroup(p: Principal, name: string, client: Client): Promise<Group> {
      return as(p, async (db) => {
        await need(db);
        const { rows } = await db.query<{ id: string; name: string }>(
          `insert into core."group" (workspace_id, name) values ($1, $2)
           on conflict (workspace_id, name) do nothing returning id, name`,
          [p.workspaceId, name],
        );
        const group = rows[0];
        if (!group) throw new UsersRefused(409, "DUPLICATE_NAME", "That name is already used.");
        await audit(db, p, client, "group.created", "group", group.id);
        return { ...group, manageable: true };
      });
    },

    async invite(p: Principal, input: InviteUsers, client: Client): Promise<InviteResult> {
      if (input.emails.length > MAX_INVITES) {
        throw new UsersRefused(422, "INVITE_LIMIT", `Invite at most ${MAX_INVITES} at a time.`);
      }
      const done = await as(p, async (db) => {
        await need(db);
        const ws = await workspace(db, p);
        if (ws.scim) {
          throw new UsersRefused(
            409,
            "SCIM_ENABLED",
            "Users are managed by your identity provider.",
          );
        }
        const role = await roleOf(db, p, input.role_id);
        if (role.admin) {
          throw new UsersRefused(
            422,
            "ADMIN_ROLE",
            "Invite into a role without administrator rights, then change it once they have joined.",
          );
        }
        if (!(await holds(db, role.permissions))) throw forbidden();
        const groups = [...new Set(input.group_ids ?? [])];
        await manageableGroups(db, p, groups);

        const invited: { id: string; email: string; token: string | null }[] = [];
        const skipped: InviteResult["skipped"] = [];
        const seen = new Set<string>();
        for (const raw of input.emails) {
          const email = raw.trim();
          const key = email.toLowerCase();
          if (!emailShape.safeParse(email).success) {
            skipped.push({ email, reason: "invalid" });
            continue;
          }
          if (seen.has(key)) {
            skipped.push({ email, reason: "duplicate" });
            continue;
          }
          seen.add(key);
          const { rows } = await db.query<{ id: string }>(
            `insert into core."user" (workspace_id, email, role_id, status)
             values ($1, $2, $3, 'invited')
             on conflict (workspace_id, lower(email)) do nothing returning id`,
            [p.workspaceId, email, role.id],
          );
          const id = rows[0]?.id;
          if (!id) {
            skipped.push({ email, reason: "exists" });
            continue;
          }
          for (const group of groups) {
            await db.query(
              "insert into core.group_member (workspace_id, group_id, user_id) values ($1, $2, $3)",
              [p.workspaceId, group, id],
            );
          }
          invited.push({ id, email, token: await issue(db, id, ws.sso) });
          await audit(db, p, client, "user.invited", "user", id, {
            role_id: role.id,
            group_ids: groups,
          });
        }
        await audit(db, p, client, "user.invite_batch", "workspace", p.workspaceId, {
          invited: invited.length,
          skipped: skipped.length,
        });
        return { slug: ws.slug, invited, skipped };
      });
      // Sent only once the accounts exist, and a few at a time.
      const invited: Invitation[] = [];
      for (let i = 0; i < done.invited.length; i += 5) {
        const batch = done.invited.slice(i, i + 5);
        invited.push(...(await Promise.all(batch.map((who) => deliver(who, done.slug)))));
      }
      return { invited, skipped: done.skipped };
    },

    async resend(p: Principal, userId: string, client: Client): Promise<Invitation> {
      const done = await as(p, async (db) => {
        await need(db);
        const ws = await workspace(db, p);
        const target = await one(db, p, userId);
        if (target.source === "scim" || ws.scim) throw scimOwned();
        if (target.status !== "invited") {
          throw new UsersRefused(409, "ALREADY_JOINED", "Only a pending invitation can be resent.");
        }
        if (target.role_id && (await roleOf(db, p, target.role_id)).admin) {
          throw new UsersRefused(422, "ADMIN_ROLE", "An administrator can't be invited by link.");
        }
        const token = await issue(db, userId, ws.sso);
        await audit(db, p, client, "user.invited", "user", userId, { resent: true });
        return { id: userId, email: target.email, token, slug: ws.slug };
      });
      return deliver(done, done.slug);
    },

    async update(
      p: Principal,
      userId: string,
      patch: UserPatch,
      client: Client,
    ): Promise<ManagedUser> {
      return as(p, async (db) => {
        await need(db);
        const { rows } = await db.query<{
          status: UserStatus;
          role_id: string | null;
          permissions: string[];
          scim_managed: boolean;
          role_from_group: boolean;
        }>(
          `select u.status, u.role_id, u.scim_managed, u.role_from_group,
                  u.extra_permissions || core.role_permissions(u.role_id) as permissions
             from core."user" u
            where u.workspace_id = $1 and u.id = $2 and u.kind = 'member' for update`,
          [p.workspaceId, userId],
        );
        const target = rows[0];
        if (!target) throw notFound();
        if (userId === p.userId) {
          throw new UsersRefused(409, "OWN_ACCOUNT", "Ask another administrator to change yours.");
        }
        // Covers group changes too, which the database does not weigh.
        if (!(await holds(db, target.permissions))) throw forbidden();

        const live = await check(db, "select core.user_can_sign_in($1) as ok", [userId]);

        let status = target.status;
        if (patch.status === "suspended") status = "suspended";
        else if (
          patch.status === "active" &&
          (status === "suspended" || status === "deprovisioned")
        ) {
          status = live ? "active" : "invited";
        }
        const statusChanged = status !== target.status;
        if (statusChanged && target.scim_managed) throw scimOwned();

        const roleId = patch.role_id ?? target.role_id;
        const roleChanged = roleId !== target.role_id;
        if (patch.role_id && roleChanged) {
          if (target.role_from_group) throw scimOwned();
          const role = await roleOf(db, p, patch.role_id);
          if (role.admin && !live) {
            throw new UsersRefused(
              409,
              "NOT_JOINED",
              "Administrator rights can be given once this person has signed in.",
            );
          }
          if (!(await holds(db, role.permissions))) throw forbidden();
        }

        if (statusChanged || roleChanged) {
          await db.query(`update core."user" set status = $2, role_id = $3 where id = $1`, [
            userId,
            status,
            roleId,
          ]);
        }

        let groupsChanged = false;
        if (patch.group_ids) {
          const wanted = [...new Set(patch.group_ids)];
          const mine = await manageableGroups(db, p, wanted);
          const now = (
            await db.query<{ group_id: string }>(
              "select group_id from core.group_member where workspace_id = $1 and user_id = $2",
              [p.workspaceId, userId],
            )
          ).rows.map((r) => r.group_id);
          const removed = now.filter((g) => mine.has(g) && !wanted.includes(g));
          const added = wanted.filter((g) => !now.includes(g));
          for (const group of removed) {
            await db.query("delete from core.group_member where group_id = $1 and user_id = $2", [
              group,
              userId,
            ]);
          }
          for (const group of added) {
            await db.query(
              "insert into core.group_member (workspace_id, group_id, user_id) values ($1, $2, $3)",
              [p.workspaceId, group, userId],
            );
          }
          for (const group of [...added, ...removed]) {
            await audit(db, p, client, "group.members_changed", "group", group, {
              added: added.includes(group) ? [userId] : [],
              removed: removed.includes(group) ? [userId] : [],
            });
          }
          groupsChanged = added.length + removed.length > 0;
        }

        // A link shown to someone must not come to open more than it did when it was made.
        if (statusChanged || roleChanged || groupsChanged) {
          await db.query("select core.revoke_invites($1)", [userId]);
        }
        if (roleChanged || (statusChanged && status === "suspended")) {
          await endAccess(db, p, userId, client);
        }

        const fields = [
          ...(roleChanged ? ["role_id"] : []),
          ...(statusChanged ? ["status"] : []),
          ...(groupsChanged ? ["group_ids"] : []),
        ];
        if (statusChanged) {
          const action = status === "suspended" ? "user.suspended" : "user.reactivated";
          await audit(db, p, client, action, "user", userId);
        }
        if (roleChanged || groupsChanged) {
          await audit(db, p, client, "user.updated", "user", userId, {
            fields,
            ...(roleChanged ? { role: { from: target.role_id, to: roleId } } : {}),
          });
        }
        return one(db, p, userId);
      });
    },

    /** Sets the password an invitation was sent for. Null for every reason it can't. */
    async accept(
      token: string,
      password: string,
      client: Client,
    ): Promise<{ workspace: string; email: string } | null> {
      // Hashed first, so a bad link takes as long to refuse as a good one to accept.
      const hash = await hashPassword(password);
      return asApp(pool, { userId: null, workspaceId: null }, async (db) => {
        const { rows } = await db.query<{
          workspace_id: string;
          user_id: string;
          email: string;
          workspace_slug: string;
        }>("select * from core.accept_invite($1, $2)", [sha256(token), hash]);
        const row = rows[0];
        if (!row) return null;
        await db.query("select set_config('app.workspace_id', $1, true)", [row.workspace_id]);
        for (const action of ["user.invite_accepted", "user.password_set"]) {
          await db.query(
            "select admin.append_audit_event($1, 'system', null, 'user', $2, '{}', $3, $4)",
            [action, row.user_id, client.ip, uaHash(client)],
          );
        }
        return { workspace: row.workspace_slug, email: row.email };
      });
    },
  };
}

export type Users = ReturnType<typeof createUsers>;
