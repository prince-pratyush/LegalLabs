import { createGateway, gatewayOptionsFromEnv } from "@legallabs/model-gateway";
import { createRunWorker } from "@legallabs/runs/temporal";
import pg from "pg";
import { runAudit } from "./agent-runs/audit.js";
import { runEngineFromEnv, schedulerFromEnv } from "./agent-runs/engine.js";
import { runHandlers } from "./agent-runs/handlers.js";
import { createAgentRuns } from "./agent-runs/runs.js";
import { createAgents } from "./agents/agents.js";
import { createContextPort } from "./agents/context.js";
import { createScheduleFirer } from "./agents/schedule-fire.js";
import { assertRestrictedRole } from "./database-role.js";

// The process that does agent and workflow runs. Stopping it mid-run loses nothing:
// Temporal hands the run to the next worker that starts.
const address = process.env.TEMPORAL_ADDRESS;
if (!address) throw new Error("TEMPORAL_ADDRESS is not set");
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is not set");

const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
pool.on("error", (err) => console.error(`database connection lost: ${err.message}`));
await assertRestrictedRole(pool);

const gateway = createGateway({
  ...gatewayOptionsFromEnv(process.env),
  recordUsage: async () => {},
});
const scheduler = await schedulerFromEnv();
const agents = createAgents(pool, {
  attachments: createContextPort(pool),
  ...(scheduler ? { scheduler } : {}),
});
const handlers = runHandlers(pool, { gateway, agents });
// The worker starts scheduled runs too, so it holds an engine client of its own.
const runs = createAgentRuns(pool, { engine: await runEngineFromEnv(pool, handlers) });
const fire = createScheduleFirer({ pool, agents, runs, scheduler: scheduler ?? undefined });

const worker = await createRunWorker({
  address,
  ...(process.env.TEMPORAL_NAMESPACE ? { namespace: process.env.TEMPORAL_NAMESPACE } : {}),
  deps: { pool, handlers, audit: runAudit(pool) },
  fire: async (id, at) => void (await fire(id, at)),
});
process.on("SIGTERM", () => worker.shutdown());
process.on("SIGINT", () => worker.shutdown());
await worker.run();
await pool.end();
