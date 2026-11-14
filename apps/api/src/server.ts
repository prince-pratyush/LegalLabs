import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import { embedderFromEnv, rerankerFromEnv } from "@legallabs/embed";
import { createIngest, type Scanner, scannerFromEnv } from "@legallabs/ingest";
import { createGateway, gatewayOptionsFromEnv } from "@legallabs/model-gateway";
import { type ObjectStore, objectStoreFromEnv } from "@legallabs/storage";
import pg from "pg";
import { createApp } from "./app.js";
import { createAuth } from "./auth/auth.js";
import { assertRestrictedRole } from "./database-role.js";
import { createDocuments } from "./documents/documents.js";
import { createIngestWorker } from "./documents/worker.js";
import { createKnowledge } from "./knowledge/knowledge.js";
import { createThreads } from "./threads/threads.js";

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

let store: ObjectStore;
try {
  store = objectStoreFromEnv(process.env);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

// Optional: without a model server, search is keywords only.
const embedder = embedderFromEnv(process.env);
const documents = createDocuments(pool, {
  store,
  embedder,
  reranker: rerankerFromEnv(process.env),
});
let scanner: Scanner;
try {
  scanner = scannerFromEnv(process.env);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

const worker = createIngestWorker(pool, {
  store,
  scanner,
  embedder,
  ingest: createIngest(process.env.DOCPROC_URL ? { docprocUrl: process.env.DOCPROC_URL } : {}),
  log: (line) => console.log(line),
});
worker.start();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  // A job cut off mid-read is picked up again once its lease runs out.
  process.once(signal, () => void worker.stop().finally(() => process.exit(0)));
}
const gateway = createGateway({
  ...gatewayOptionsFromEnv(process.env),
  // A no-op: usage goes on the answer's message row, so it is saved or rolled back with it.
  recordUsage: async () => {},
});

// The web app's build, when present, so the demo runs from one server on one origin.
const webRoot = fileURLToPath(new URL("../../web/dist", import.meta.url));

const app = createApp({
  auth: createAuth(pool),
  documents,
  threads: createThreads(pool, { gateway, documents }),
  knowledge: createKnowledge(pool, { embedder }),
  clientIp: (c) => getConnInfo(c).remote.address ?? null,
  ...(existsSync(webRoot) ? { webRoot } : {}),
});

serve({
  fetch: app.fetch,
  hostname: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 8787),
});
