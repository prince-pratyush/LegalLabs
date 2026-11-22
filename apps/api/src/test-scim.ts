import { createHash, randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import { seedMember } from "./test-db.js";

export const sha256 = (text: string) => createHash("sha256").update(text).digest();

export interface ScimWorkspace {
  slug: string;
  workspaceId: string;
  adminId: string;
  adminRoleId: string;
  servicePrincipalId: string;
  token: string;
}

/** Inserts a token for a service user directly, as an operator would; tests then exercise it. */
export async function seedToken(
  pool: pg.Pool,
  workspaceId: string,
  principalId: string,
  scopes: string[] = ["scim"],
) {
  const token = `scim_${randomBytes(24).toString("base64url")}`;
  await pool.query(
    `insert into core.api_token (workspace_id, principal_id, name, token_hash, scopes, expires_at)
     values ($1, $2, 'test', $3, $4, now() + interval '90 days')`,
    [workspaceId, principalId, sha256(token), scopes],
  );
  return token;
}

/** A workspace with an admin, SCIM switched on, and a service user holding a scim token. */
export async function seedScim(pool: pg.Pool, settings: object = {}): Promise<ScimWorkspace> {
  const m = await seedMember(pool);
  await pool.query(
    "update core.workspace set settings = settings || $2::jsonb || '{\"scim_enabled\": true}' where id = $1",
    [m.workspaceId, JSON.stringify(settings)],
  );
  const { rows } = await pool.query<{ id: string }>(
    `insert into core."user" (workspace_id, email, kind, status)
     values ($1, $2, 'service', 'active') returning id`,
    [m.workspaceId, `scim-${randomUUID().slice(0, 6)}@service.invalid`],
  );
  const principal = rows[0]?.id ?? "";
  const role = await pool.query<{ id: string }>(
    "select id from core.role where workspace_id = $1 and name = 'Admin'",
    [m.workspaceId],
  );
  return {
    slug: m.slug,
    workspaceId: m.workspaceId,
    adminId: m.userId,
    adminRoleId: role.rows[0]?.id ?? "",
    servicePrincipalId: principal,
    token: await seedToken(pool, m.workspaceId, principal),
  };
}

/** A second person holding the same Admin role. */
export async function addAdmin(pool: pg.Pool, w: ScimWorkspace): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into core."user" (workspace_id, email, role_id, status)
     values ($1, $2, $3, 'active') returning id`,
    [w.workspaceId, `admin2-${randomUUID().slice(0, 6)}@${w.slug}.test`, w.adminRoleId],
  );
  return rows[0]?.id ?? "";
}

/** A member with no rights at all. */
export async function addPlainMember(pool: pg.Pool, w: ScimWorkspace): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into core."user" (workspace_id, email, status)
     values ($1, $2, 'active') returning id`,
    [w.workspaceId, `plain-${randomUUID().slice(0, 6)}@${w.slug}.test`],
  );
  return rows[0]?.id ?? "";
}
