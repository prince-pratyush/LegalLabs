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
import { createAdminConnectors } from "./admin-models/connectors.js";
import { httpDiscovery } from "./admin-models/discovery.js";
import { createAdminModels } from "./admin-models/models.js";
import { createSecretBox } from "./admin-models/secrets.js";
import { runEngineFromEnv, schedulerFromEnv } from "./agent-runs/engine.js";
import { runHandlers } from "./agent-runs/handlers.js";
import { createAgentRuns } from "./agent-runs/runs.js";
import { createAgents } from "./agents/agents.js";
import { createAgentSharing } from "./agents/config.js";
import { createContextPort } from "./agents/context.js";
import { createNudges } from "./agents/nudges.js";
import { createApp } from "./app.js";
import { createAnchorJob } from "./audit/anchor-job.js";
import { createAuth } from "./auth/auth.js";
import { mfaFromEnv, mfaStartupCheck } from "./auth/mfa/config.js";
import { createOidc } from "./auth/oidc/service.js";
import { createClientIp, trustedProxiesFromEnv } from "./client-ip.js";
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
import { createMatters } from "./matters/matters.js";
import { createMemoryModule } from "./memory/module.js";
import { createMemoryPurgeJob } from "./memory/purge.js";
import { createLogEmailProvider } from "./notifications/email-port.js";
import { createEmailWorker } from "./notifications/email-worker.js";
import { createNotifications } from "./notifications/notifications.js";
import { createPurgeJob } from "./notifications/purge.js";
import { registerThreadActions } from "./notifications/register.js";
import { createPlaybooks } from "./playbooks/playbooks.js";
import { createPublicApi } from "./public-api/service.js";
import { createRetentionSweepJob } from "./retention/job.js";
import { createRetention } from "./retention/service.js";
import { createReviews } from "./reviews/reviews.js";
import { validatorFromEnv } from "./reviews/soffice.js";
import { createRunLog } from "./runs/log.js";
import { createScimAdmin } from "./scim/admin.js";
import { createScim } from "./scim/service.js";
import { createSpaceModule } from "./spaces/module.js";
import { spaceNotifier } from "./spaces/notify.js";
import { scriptedTaskRuns } from "./spaces/ports.js";
import { createSyncModule } from "./sync/module.js";
import { createReviewTables } from "./tables/module.js";
import { createThreads } from "./threads/threads.js";
import { createVaultPort } from "./vaults/port.js";
import { createRetentionJob } from "./vaults/retention.js";
import { createVaults } from "./vaults/vaults.js";
import { createWorkflows } from "./workflows/workflows.js";

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
// Daily audit anchors, written outside the database (06-security 9.1). Point S3_ANCHOR_BUCKET at
// a bucket with Object Lock in compliance mode; without it they go under audit-anchors/ in the
// content bucket, which proves nothing against someone who can write that bucket.
const anchorJob = createAnchorJob(pool, {
  store: process.env.S3_ANCHOR_BUCKET
    ? objectStoreFromEnv({ ...process.env, S3_BUCKET: process.env.S3_ANCHOR_BUCKET })
    : store,
  log: (line) => console.log(line),
});
anchorJob.start();
const notifications = createNotifications(pool);
const notifier = notifications.notifier;
// The policy-driven sweep (ADM-004): bins what a retention policy has expired, empties the bin
// after 30 days, deletes the stored files and warns owners. The job above only knows a vault's
// own hours; without this one no retention policy is ever carried out.
const retentionSweep = createRetentionSweepJob(pool, {
  store,
  notifications: notifier,
  log: (line) => console.log(line),
});
retentionSweep.start();
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
        anchorJob.stop(),
        retentionSweep.stop(),
        notificationPurge.stop(),
        memoryPurge.stop(),
        emailWorker.stop(),
        syncModule.stop(),
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
// Without LEGALLABS_SECRETS_KEY keys and tokens can't be stored, so those calls answer 503.
const secrets = process.env.LEGALLABS_SECRETS_KEY
  ? createSecretBox(process.env.LEGALLABS_SECRETS_KEY)
  : undefined;
const vaultService = createVaults(pool, { documents, store, notifier });
// Drive and SharePoint sync into vaults (CON-002), run by its own scheduler.
const syncModule = createSyncModule(pool, {
  ...(secrets ? { secrets } : {}),
  vaults: vaultService,
  notifier,
  documentsFor: (p) =>
    createDocuments(p, { store, embedder, reranker: rerankerFromEnv(process.env) }),
  log: (line) => console.log(line),
});
syncModule.scheduler?.start();
const adminModels = {
  models: createAdminModels(pool, secrets ? { secrets } : {}),
  connectors: createAdminConnectors(pool, {
    ...(secrets ? { secrets } : {}),
    discovery: httpDiscovery,
  }),
};
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

const scheduler = await schedulerFromEnv();
const agents = createAgents(pool, {
  attachments: createContextPort(pool),
  documents,
  ...(scheduler ? { scheduler } : {}),
});
const agentRuns = createAgentRuns(pool, {
  engine: await runEngineFromEnv(pool, runHandlers(pool, { gateway, agents, documents })),
});

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

const mfaOption = mfaFromEnv(process.env, pool);
const mfaCheck = mfaStartupCheck(process.env, mfaOption.mfa !== undefined);
if (mfaCheck.action === "refuse") {
  console.error(mfaCheck.message);
  process.exit(1);
}
if (mfaCheck.action === "warn") console.warn(mfaCheck.message);
const app = createApp({
  agentRuns,
  scim: { service: createScim(pool), admin: createScimAdmin(pool) },
  publicApi: createPublicApi(pool),
  // Retention policies, legal holds and the recycle bin (ADM-004).
  retention: createRetention(pool, { store, notifications: notifier }),
  workflows: createWorkflows(pool, {
    documents,
    agentRuns,
    // Explicit models on a block must be ones this install can actually route to.
    allowedModels: () => [
      ...new Set(
        (["synthesize", "read_extract", "draft_edit"] as const).flatMap((t) =>
          gateway.models(t).map((m) => m.id),
        ),
      ),
    ],
  }),
  agents,
  agentSharing: createAgentSharing(pool),
  agentNudges: createNudges(pool),
  auth: createAuth(pool),
  ...mfaOption,
  oidc: createOidc(pool, {
    ...(mfaOption.mfa ? { secondFactor: mfaOption.mfa.secondStep } : {}),
    baseUrl: process.env.LEGALLABS_PUBLIC_URL || "http://localhost:5173",
    // Plain http and private addresses, for a local IdP only; never in production.
    policy: {
      insecureDev: process.env.OIDC_INSECURE_DEV === "1" && process.env.NODE_ENV !== "production",
    },
  }),
  documents,
  vaults: vaultService,
  sync: syncModule.service,
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
  adminModels,
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
  matters: createMatters(pool),
  // Tasks given to the assistant or an agent run on the scripted stand-in until the run engine
  // implements `TaskRunPort`; it calls no model.
  spaces: createSpaceModule(pool, {
    runs: scriptedTaskRuns(),
    notifier: spaceNotifier(notifier),
    // The workspace may let a Space hold resources from another matter.
    allowMatterMismatch: async (db) =>
      (
        await db.query<{ ok: boolean }>(
          "select coalesce((select allow_matter_mismatch_in_spaces from core.matter_options), false) as ok",
        )
      ).rows[0]?.ok ?? false,
  }),
  tables,
  // The socket address, or the client behind a proxy the deployer listed in
  // LEGALLABS_TRUSTED_PROXIES (comma-separated addresses or CIDR blocks of the ingress).
  clientIp: createClientIp(
    trustedProxiesFromEnv(process.env),
    (c) => getConnInfo(c).remote.address ?? null,
  ),
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
