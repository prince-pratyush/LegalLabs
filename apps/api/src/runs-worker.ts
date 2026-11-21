import { createRunWorker } from "@legallabs/runs/temporal";
import pg from "pg";
import { runAudit } from "./agent-runs/audit.js";
import { runHandlers } from "./agent-runs/handlers.js";
import { assertRestrictedRole } from "./database-role.js";

// The process that does agent and workflow runs. Stopping it mid-run loses nothing:
// Temporal hands the run to the next worker that starts.
const address = process.env.TEMPORAL_ADDRESS;
if (!address) throw new Error("TEMPORAL_ADDRESS is not set");
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is not set");

const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
await assertRestrictedRole(pool);

const worker = await createRunWorker({
  address,
  ...(process.env.TEMPORAL_NAMESPACE ? { namespace: process.env.TEMPORAL_NAMESPACE } : {}),
  deps: { pool, handlers: runHandlers(pool), audit: runAudit(pool) },
});
process.on("SIGTERM", () => worker.shutdown());
process.on("SIGINT", () => worker.shutdown());
await worker.run();
await pool.end();
