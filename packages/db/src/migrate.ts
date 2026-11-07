import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate as run } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

export const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

// Runs as the schema owner, never as the app role, which cannot create objects.
export async function migrate(databaseUrl: string): Promise<void> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    await run(drizzle(pool), { migrationsFolder });
  } finally {
    await pool.end();
  }
}
