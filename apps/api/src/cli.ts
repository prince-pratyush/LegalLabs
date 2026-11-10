#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { text } from "node:stream/consumers";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { hashPassword } from "./auth/password.js";

export interface Io {
  databaseUrl: string | undefined;
  readPassword(): Promise<string>;
  print(line: string): void;
}

const USAGE = `usage (password on stdin, never as an argument):
  printf %s "$PASSWORD" | legallabs-admin create-admin <workspace-slug> <email>`;

// Runs as the schema owner: this is how the very first person gets in.
async function createAdmin(io: Io, slug: string, email: string): Promise<number> {
  if (!io.databaseUrl) {
    io.print("failed: DATABASE_URL is not set");
    return 2;
  }
  const password = await io.readPassword();
  if (password.length < 12 || password.length > 256) {
    io.print("failed: the password needs at least 12 characters and at most 256");
    return 1;
  }
  const passwordHash = await hashPassword(password);

  const client = new pg.Client({ connectionString: io.databaseUrl });
  await client.connect();
  const id = async (sql: string, params: unknown[]) => {
    const row = (await client.query<{ id: string }>(sql, params)).rows[0];
    if (!row) throw new Error("that email belongs to a guest or service account");
    return row.id;
  };
  try {
    await client.query("begin");
    const workspaceId = await id(
      `insert into core.workspace (slug, name, region) values ($1, $1, 'au')
       on conflict (slug) do update set slug = excluded.slug returning id`,
      [slug],
    );
    const roleId = await id(
      `insert into core.role (workspace_id, name, builtin, permissions) values ($1, 'Admin', true, '{*}')
       on conflict (workspace_id, name) do update set name = excluded.name returning id`,
      [workspaceId],
    );
    const userId = await id(
      `insert into core."user" (workspace_id, email, role_id, status) values ($1, $2, $3, 'active')
       on conflict (workspace_id, lower(email)) do update
         set role_id = excluded.role_id, status = 'active' where core."user".kind = 'member'
       returning id`,
      [workspaceId, email, roleId],
    );
    await client.query(
      `insert into core.password_credential (workspace_id, user_id, password_hash) values ($1, $2, $3)
       on conflict (workspace_id, user_id) do update
         set password_hash = excluded.password_hash, updated_at = now()`,
      [workspaceId, userId, passwordHash],
    );
    await client.query("select set_config('app.workspace_id', $1, true)", [workspaceId]);
    await client.query(
      "select admin.append_audit_event('user.password_set', 'system', null, 'user', $1)",
      [userId],
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

export async function run(args: string[], io: Io): Promise<number> {
  const [command, slug, email] = args;
  if (command === "create-admin" && slug && email) return createAdmin(io, slug, email);
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
