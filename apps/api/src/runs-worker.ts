import { embedderFromEnv, rerankerFromEnv } from "@legallabs/embed";
import { createGateway, gatewayOptionsFromEnv } from "@legallabs/model-gateway";
import { createRunWorker } from "@legallabs/runs/temporal";
import { objectStoreFromEnv } from "@legallabs/storage";
import pg from "pg";
import { runHandlers } from "./agent-runs/handlers.js";
import { assertRestrictedRole } from "./database-role.js";
import { createDocuments } from "./documents/documents.js";

// The process that does agent and workflow runs. Stopping it mid-run loses nothing:
// Temporal hands the run to the next worker that starts.
const address = process.env.TEMPORAL_ADDRESS;
if (!address) throw new Error("TEMPORAL_ADDRESS is not set");
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is not set");

const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
await assertRestrictedRole(pool);

// Workflow steps call models and search documents from this process, as the run's owner.
const gateway = createGateway({
  ...gatewayOptionsFromEnv(process.env),
  recordUsage: async () => {},
});
const documents = createDocuments(pool, {
  store: objectStoreFromEnv(process.env),
  embedder: embedderFromEnv(process.env),
  reranker: rerankerFromEnv(process.env),
});

const worker = await createRunWorker({
  address,
  ...(process.env.TEMPORAL_NAMESPACE ? { namespace: process.env.TEMPORAL_NAMESPACE } : {}),
  deps: { pool, handlers: runHandlers(pool, { gateway, documents }) },
});
process.on("SIGTERM", () => worker.shutdown());
process.on("SIGINT", () => worker.shutdown());
await worker.run();
await pool.end();
