import { serve } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import pg from "pg";
import { createApp } from "./app.js";
import { createAuth } from "./auth/auth.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: databaseUrl, max: 5 });
// Without a listener, a dropped idle connection would take the whole process down.
pool.on("error", (err) => console.error(`database connection lost: ${err.message}`));

const app = createApp({
  auth: createAuth(pool),
  clientIp: (c) => getConnInfo(c).remote.address ?? null,
});

serve({
  fetch: app.fetch,
  hostname: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 8787),
});
