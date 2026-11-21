import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import { embedderFromEnv, rerankerFromEnv } from "@legallabs/embed";
import { createIngest, type Scanner, scannerFromEnv } from "@legallabs/ingest";
import { createGateway, gatewayOptionsFromEnv } from "@legallabs/model-gateway";
import { type ObjectStore, objectStoreFromEnv } from "@legallabs/storage";
import pg from "pg";
import { createSignInAudit } from "./addins/audit.js";
import { createLanguage } from "./addins/language.js";
import { createApp } from "./app.js";
import { createAuth } from "./auth/auth.js";
import { assertRestrictedRole } from "./database-role.js";
import { asWorker } from "./db.js";
import { createDocuments } from "./documents/documents.js";
import { createViewer } from "./documents/viewer.js";
import { createIngestWorker } from "./documents/worker.js";
import { createDrafts } from "./drafts/drafts.js";
import { createKnowledge } from "./knowledge/knowledge.js";
import { knowledgePort } from "./knowledge/port.js";
import { createLibrary } from "./library/library.js";
import { createTemplatePort } from "./library/port.js";
import { createMemoryModule } from "./memory/module.js";
import { createMemoryPurgeJob } from "./memory/purge.js";
import { createLogEmailProvider } from "./notifications/email-port.js";
import { createEmailWorker } from "./notifications/email-worker.js";
import { createNotifications } from "./notifications/notifications.js";
import { createPurgeJob } from "./notifications/purge.js";
import { registerThreadActions } from "./notifications/register.js";
import { createPlaybooks } from "./playbooks/playbooks.js";
import { createReviews } from "./reviews/reviews.js";
import { validatorFromEnv } from "./reviews/soffice.js";
import { createRunLog } from "./runs/log.js";
import { createReviewTables } from "./tables/module.js";
import { createThreads } from "./threads/threads.js";
import { createVaultPort } from "./vaults/port.js";
import { createRetentionJob } from "./vaults/retention.js";
import { createVaults } from "./vaults/vaults.js";

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
const retention = createRetentionJob(pool, { store, log: (line) => console.log(line) });
retention.start();
const notifications = createNotifications(pool);
const notifier = notifications.notifier;
const notificationPurge = createPurgeJob(notifications, { log: (line) => console.log(line) });
notificationPurge.start();
// Mail goes to the log until a real provider is plugged in; links use the public web address.
const emailWorker = createEmailWorker(pool, {
  provider: createLogEmailProvider((line) => console.log(line)),
  baseUrl: process.env.LEGALLABS_PUBLIC_URL || "http://localhost:5173",
  log: (line) => console.log(line),
});
emailWorker.start();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  // A job cut off mid-read is picked up again once its lease runs out.
  process.once(
    signal,
    () =>
      void Promise.all([
        worker.stop(),
        retention.stop(),
        notificationPurge.stop(),
        memoryPurge.stop(),
        emailWorker.stop(),
      ]).finally(() => process.exit(0)),
  );
}
const gateway = createGateway({
  ...gatewayOptionsFromEnv(process.env),
  // A no-op: usage goes on the answer's message row, so it is saved or rolled back with it.
  recordUsage: async () => {},
});

// The web app's build, when present, so the demo runs from one server on one origin.
const webRoot = fileURLToPath(new URL("../../web/dist", import.meta.url));

// The Word add-in's pane, served under /addin/ when built.
const addinRoot = fileURLToPath(new URL("../../word-addin/dist", import.meta.url));
const log = createRunLog(pool);
// Runs live in this process, so any left unfinished by the last one can never finish.
// One API process per database for now; several would need a lease per run.
const orphaned = await asWorker(pool, async (db) => {
  const { rows } = await db.query<{ n: number }>("select work.fail_orphaned_runs(now()) n");
  return rows[0]?.n ?? 0;
});
if (orphaned > 0) console.log(`marked ${orphaned} unfinished runs as failed`);
// Cells those runs left queued or running go back to waiting.
await asWorker(pool, (db) => db.query("select work.rt_reset_orphaned_cells()"));
const cellsInFlight = Number(process.env.LEGALLABS_TABLE_CELLS_IN_FLIGHT);
const vaults = createVaultPort(pool);
const knowledgeStore = createKnowledge(pool, { embedder });
const knowledge = knowledgePort(knowledgeStore);
const memory = createMemoryModule(pool, {
  gateway,
  // PDF, Word and text samples, read the same way uploaded files are.
  read: createIngest(process.env.DOCPROC_URL ? { docprocUrl: process.env.DOCPROC_URL } : {}),
});
const memoryPurge = createMemoryPurgeJob(memory.memories, { log: (line) => console.log(line) });
memoryPurge.start();
const threadService = createThreads(pool, {
  gateway,
  documents,
  log,
  vaults,
  knowledge,
  notifier,
  personalisation: memory.personalisation,
});
registerThreadActions(notifications.actions, threadService);
const asks = Number(process.env.LEGALLABS_ASKS_PER_10_MIN);

const tables = createReviewTables(pool, {
  gateway,
  documents,
  log,
  notifier,
  syncLog: (line) => console.log(line),
  ...(Number.isInteger(cellsInFlight) && cellsInFlight > 0 ? { cellsInFlight } : {}),
});
// Tables over a vault with sync on pick up new files on this schedule, each as its owner.
tables.sync.start();
process.once("SIGTERM", () => void tables.sync.stop());
process.once("SIGINT", () => void tables.sync.stop());

const app = createApp({
  auth: createAuth(pool),
  documents,
  vaults: createVaults(pool, { documents, store, notifier }),
  threads: {
    threads: threadService,
    log,
    gateway,
    vaults,
    knowledge,
    ...(Number.isInteger(asks) && asks > 0 ? { asksPerWindow: asks } : {}),
  },
  viewer: createViewer(pool, store, documents),
  playbooks: createPlaybooks(pool, { gateway }),
  notifications,
  memory,
  reviews: createReviews(pool, {
    gateway,
    notifier,
    store,
    log,
    // A local model serves about two calls at once; raise it for a hosted provider.
    parallelism: Number(process.env.LEGALLABS_REVIEW_PARALLELISM) || 2,
    // A run stops here and keeps what it finished.
    maxCostUsd: Number(process.env.LEGALLABS_REVIEW_MAX_COST_USD) || 5,
    validate: validatorFromEnv(process.env),
  }),
  drafts: createDrafts(pool, { gateway, templates: createTemplatePort(pool) }),
  knowledge: knowledgeStore,
  library: createLibrary(pool),
  tables,
  clientIp: (c) => getConnInfo(c).remote.address ?? null,
  ...(existsSync(webRoot) ? { webRoot } : {}),
  addin: {
    language: createLanguage(gateway),
    recordSignIn: createSignInAudit(pool),
    ...(existsSync(addinRoot) ? { root: addinRoot } : {}),
  },
});

serve({
  fetch: app.fetch,
  hostname: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 8787),
});
