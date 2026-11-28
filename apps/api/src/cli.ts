#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { text } from "node:stream/consumers";
import { fileURLToPath } from "node:url";
import { DEFAULT_USER_PERMISSIONS, isAdminPermission } from "@legallabs/contracts";
import pg from "pg";
import { hashPassword, MAX_PASSWORD_LENGTH } from "./auth/password.js";

export interface Io {
  databaseUrl: string | undefined;
  readPassword(): Promise<string>;
  print(line: string): void;
}

const USAGE = `usage (password on stdin, never as an argument):
  printf %s "$PASSWORD" | legallabs-admin create-admin <workspace-slug> <email>
  printf %s "$PASSWORD" | legallabs-admin create-user <workspace-slug> <email> [role]
create-user adds someone to an existing workspace with the User role unless another is named;
it never gives administrator rights.`;

// Every workspace made here gets the ordinary role beside Admin.
const ensureUserRole = (client: pg.Client, workspaceId: string) =>
  client.query(
    `insert into core.role (workspace_id, name, builtin, permissions) values ($1, 'User', true, $2)
     on conflict (workspace_id, name) do nothing`,
    [workspaceId, DEFAULT_USER_PERMISSIONS],
  );

const badPassword = (password: string) =>
  password.length < 12 || password.length > MAX_PASSWORD_LENGTH;

// Runs as the schema owner: this is how the very first person gets in.
async function createAdmin(io: Io, slug: string, email: string): Promise<number> {
  if (!io.databaseUrl) {
    io.print("failed: DATABASE_URL is not set");
    return 2;
  }
  const password = await io.readPassword();
  if (badPassword(password)) {
    io.print("failed: the password needs at least 12 characters and at most 256");
    return 1;
  }
  const passwordHash = await hashPassword(password);

  const client = new pg.Client({ connectionString: io.databaseUrl });
  await client.connect();
  const returningId = async (sql: string, params: unknown[]) => {
    const row = (await client.query<{ id: string }>(sql, params)).rows[0];
    if (!row) throw new Error("that email belongs to a guest or service account");
    return row.id;
  };
  try {
    await client.query("begin");
    const workspaceId = await returningId(
      `insert into core.workspace (slug, name, region) values ($1, $1, 'au')
       on conflict (slug) do update set slug = excluded.slug returning id`,
      [slug],
    );
    const roleId = await returningId(
      `insert into core.role (workspace_id, name, builtin, permissions) values ($1, 'Admin', true, '{*}')
       on conflict (workspace_id, name) do update set name = excluded.name returning id`,
      [workspaceId],
    );
    await ensureUserRole(client, workspaceId);
    const userId = await returningId(
      `insert into core."user" (workspace_id, email, role_id, status) values ($1, $2, $3, 'active')
       on conflict (workspace_id, lower(email)) do update
         set email = core."user".email where core."user".kind = 'member'
       returning id`,
      [workspaceId, email, roleId],
    );
    await client.query(
      `insert into core.password_credential (workspace_id, user_id, password_hash) values ($1, $2, $3)
       on conflict (workspace_id, user_id) do update
         set password_hash = excluded.password_hash, updated_at = now()`,
      [workspaceId, userId, passwordHash],
    );
    // A new password must lock out whoever had the old one.
    const revoked = await client.query(
      `update core.session set revoked_at = now()
        where workspace_id = $1 and user_id = $2 and revoked_at is null`,
      [workspaceId, userId],
    );
    await client.query("select set_config('app.workspace_id', $1, true)", [workspaceId]);
    await client.query(
      "select admin.append_audit_event('user.password_set', 'system', null, 'user', $1, $2)",
      [userId, JSON.stringify({ sessions_revoked: revoked.rowCount })],
    );
    await client.query("commit");
    io.print(`ok: ${email} can now sign in to ${slug}`);
    return 0;
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    io.print(`failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    await client.end();
  }
}

// Adds an ordinary person. Never changes anyone who already exists.
async function createUser(io: Io, slug: string, email: string, roleName: string): Promise<number> {
  if (!io.databaseUrl) {
    io.print("failed: DATABASE_URL is not set");
    return 2;
  }
  const password = await io.readPassword();
  if (badPassword(password)) {
    io.print("failed: the password needs at least 12 characters and at most 256");
    return 1;
  }
  const passwordHash = await hashPassword(password);

  const client = new pg.Client({ connectionString: io.databaseUrl });
  await client.connect();
  try {
    await client.query("begin");
    const workspace = (
      await client.query<{ id: string; scim: boolean; sso: boolean }>(
        `select w.id, coalesce(w.settings ->> 'scim_enabled' = 'true', false) as scim,
                exists (select 1 from core.oidc_provider p
                         where p.workspace_id = w.id and p.enabled) as sso
           from core.workspace w where w.slug = $1`,
        [slug],
      )
    ).rows[0];
    if (!workspace) throw new Error("no such workspace; create-admin makes one");
    if (workspace.scim) throw new Error("users are managed by your identity provider (SCIM is on)");
    await ensureUserRole(client, workspace.id);
    const role = (
      await client.query<{ id: string; permissions: string[] }>(
        "select id, permissions from core.role where workspace_id = $1 and name = $2",
        [workspace.id, roleName],
      )
    ).rows[0];
    if (!role) throw new Error(`no role named ${roleName}`);
    if (role.permissions.some(isAdminPermission)) {
      throw new Error("that role has administrator rights; use create-admin for an administrator");
    }
    const userId = (
      await client.query<{ id: string }>(
        `insert into core."user" (workspace_id, email, role_id, status)
         values ($1, $2, $3, 'active')
         on conflict (workspace_id, lower(email)) do nothing returning id`,
        [workspace.id, email, role.id],
      )
    ).rows[0]?.id;
    if (!userId) throw new Error("someone with that email is already in the workspace");
    await client.query(
      `insert into core.password_credential (workspace_id, user_id, password_hash)
       values ($1, $2, $3)`,
      [workspace.id, userId, passwordHash],
    );
    await client.query("select set_config('app.workspace_id', $1, true)", [workspace.id]);
    for (const action of ["user.created", "user.password_set"]) {
      await client.query("select admin.append_audit_event($1, 'system', null, 'user', $2, '{}')", [
        action,
        userId,
      ]);
    }
    await client.query("commit");
    io.print(
      workspace.sso
        ? `ok: ${email} added to ${slug}. Single sign-on is on, so their password won't be accepted`
        : `ok: ${email} can now sign in to ${slug} as ${roleName}`,
    );
    return 0;
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    io.print(`failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    await client.end();
  }
}

export async function run(args: string[], io: Io): Promise<number> {
  const [command, slug, email, role = "User"] = args;
  if (command === "create-admin" && slug && email) return createAdmin(io, slug, email);
  if (command === "create-user" && slug && email) return createUser(io, slug, email, role);
  io.print(USAGE);
  return 2;
}

// Resolved so the check still holds when run through a package manager's symlink.
const entry = process.argv[1];
if (entry && realpathSync(entry) === fileURLToPath(import.meta.url)) {
  process.exitCode = await run(process.argv.slice(2), {
    databaseUrl: process.env.DATABASE_URL,
    readPassword: async () => (await text(process.stdin)).replace(/\r?\n$/, ""),
    print: (line) => console.log(line),
  });
}
