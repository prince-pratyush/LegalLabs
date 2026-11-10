import type pg from "pg";

// Row-level security only holds if the connection itself cannot step around it.
export async function assertRestrictedRole(pool: pg.Pool): Promise<void> {
  const { rows } = await pool.query<{ name: string; unsafe: boolean }>(
    `select r.rolname as name,
            r.rolsuper or r.rolbypassrls or has_schema_privilege(r.oid, 'core', 'create') as unsafe
       from pg_roles r where r.rolname = current_user`,
  );
  if (rows[0]?.unsafe !== false) {
    throw new Error(
      `refusing to run as ${rows[0]?.name ?? "unknown"}: connect as legallabs_api, not an owner`,
    );
  }
}
