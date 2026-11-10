import { randomUUID } from "node:crypto";
import pg from "pg";
import { inject } from "vitest";
import { hashPassword } from "./auth/password.js";

export const testPool = () => new pg.Pool({ connectionString: inject("databaseUrl"), max: 3 });

export const PASSWORD = "correct horse battery";

export interface Seeded {
  slug: string;
  workspaceId: string;
  userId: string;
  email: string;
}

// Commits for real, so each call gets its own workspace.
export async function seedMember(
  pool: pg.Pool,
  opts: { status?: string; password?: boolean; permissions?: string[] } = {},
): Promise<Seeded> {
  const slug = `ws-${randomUUID().slice(0, 8)}`;
  const email = `ana@${slug}.test`;
  const one = async (sql: string, params: unknown[]) =>
    (await pool.query<{ id: string }>(sql, params)).rows[0]?.id ?? "";
  const workspaceId = await one(
    "insert into core.workspace (slug, name, region) values ($1, $1, 'au') returning id",
    [slug],
  );
  const roleId = await one(
    "insert into core.role (workspace_id, name, permissions) values ($1, 'Admin', $2) returning id",
    [workspaceId, opts.permissions ?? ["*"]],
  );
  const userId = await one(
    `insert into core."user" (workspace_id, email, role_id, status) values ($1, $2, $3, $4) returning id`,
    [workspaceId, email, roleId, opts.status ?? "active"],
  );
  if (opts.password !== false) {
    await pool.query(
      "insert into core.password_credential (workspace_id, user_id, password_hash) values ($1, $2, $3)",
      [workspaceId, userId, await hashPassword(PASSWORD)],
    );
  }
  return { slug, workspaceId, userId, email };
}

export async function auditTrail(pool: pg.Pool, workspaceId: string) {
  const { rows } = await pool.query(
    `select action, actor_type, actor_id, object_type, object_id, details
       from admin.audit_event where workspace_id = $1 order by seq`,
    [workspaceId],
  );
  return rows;
}
