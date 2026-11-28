import type pg from "pg";

// SEC-002: a production deployment refuses to start while it still looks like a demo. Messages
// name the setting, never its value.

const KNOWN_DEFAULTS = new Set([
  "admin",
  "change-me",
  "changeme",
  "example",
  "legallabs",
  "minioadmin",
  "password",
  "postgres",
  "rustfsadmin",
  "secret",
  "test",
]);
const MIN_SECRET = 16;

const isDefault = (value: string) =>
  KNOWN_DEFAULTS.has(value.toLowerCase()) || /^<.*>$|change.?me/i.test(value);
const weakSecret = (value: string) => isDefault(value) || value.length < MIN_SECRET;
// A generated 32-byte key never repeats a handful of bytes; a typed placeholder does.
const weakKey = (value: string) => {
  const bytes = Buffer.from(value, "base64");
  return isDefault(value) || bytes.length !== 32 || new Set(bytes).size < 8;
};

function databasePassword(url: string | undefined): string | null {
  if (!url || !URL.canParse(url)) return null;
  const { password } = new URL(url);
  return password ? decodeURIComponent(password) : null;
}

export function unsafeSettings(env: Record<string, string | undefined>): string[] {
  const found: string[] = [];
  const bad = (name: string, why: string) => found.push(`${name} ${why}`);
  const password = databasePassword(env.DATABASE_URL);
  if (password !== null && weakSecret(password)) {
    bad("DATABASE_URL", "has a default or short password");
  }
  if (env.S3_ACCESS_KEY_ID && isDefault(env.S3_ACCESS_KEY_ID)) {
    bad("S3_ACCESS_KEY_ID", "is a well-known default");
  }
  if (env.S3_SECRET_ACCESS_KEY && weakSecret(env.S3_SECRET_ACCESS_KEY)) {
    bad("S3_SECRET_ACCESS_KEY", "is a default or short value");
  }
  for (const name of ["LEGALLABS_SECRETS_KEY", "LEGALLABS_MFA_KEY"]) {
    const value = env[name];
    if (value && weakKey(value)) bad(name, "is not a generated 32-byte key");
  }
  if (!env.LEGALLABS_PUBLIC_URL?.startsWith("https://")) {
    bad("LEGALLABS_PUBLIC_URL", "must be the https address people use");
  }
  if (env.OIDC_INSECURE_DEV === "1") bad("OIDC_INSECURE_DEV", "must not be set in production");
  return found;
}

/** Every application table must have row-level security enabled, forced and with a policy. */
export async function tablesWithoutRls(db: pg.Pool): Promise<string[]> {
  const { rows } = await db.query<{ name: string }>(
    `select n.nspname || '.' || c.relname as name
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r', 'p')
        and n.nspname not in ('information_schema', 'public', 'drizzle')
        and n.nspname not like 'pg\\_%'
        and (not c.relrowsecurity or not c.relforcerowsecurity
             or not exists (select 1 from pg_policy p where p.polrelid = c.oid))
      order by 1`,
  );
  return rows.map((r) => r.name);
}

/** Throws, listing every problem, unless a production deployment is safe to serve. */
export async function assertSafeDeployment(
  env: Record<string, string | undefined>,
  db: pg.Pool,
  publicBuckets: () => Promise<string[]>,
): Promise<void> {
  if (env.NODE_ENV !== "production") return;
  const problems = unsafeSettings(env);
  for (const table of await tablesWithoutRls(db)) {
    problems.push(`table ${table} lacks forced row-level security`);
  }
  try {
    for (const bucket of await publicBuckets()) {
      problems.push(`bucket ${bucket} allows anonymous access`);
    }
  } catch (err) {
    problems.push(`bucket access could not be checked: ${(err as Error).message}`);
  }
  if (problems.length > 0) {
    throw new Error(`refusing to start:\n  - ${problems.join("\n  - ")}`);
  }
}
