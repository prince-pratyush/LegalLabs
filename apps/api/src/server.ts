import { serve } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import pg from "pg";
import { createApp } from "./app.js";
import { createAuth } from "./auth/auth.js";
import { assertRestrictedRole } from "./database-role.js";
import { createDocuments } from "./documents/documents.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: databaseUrl, max: 5 });
// Without a listener, a dropped idle connection would take the whole process down.
pool.on("error", (err) => console.error(`database connection lost: ${err.message}`));

try {
  await assertRestrictedRole(pool);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

const app = createApp({
  auth: createAuth(pool),
  documents: createDocuments(pool),
  clientIp: (c) => getConnInfo(c).remote.address ?? null,
});

serve({
  fetch: app.fetch,
  hostname: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 8787),
});
