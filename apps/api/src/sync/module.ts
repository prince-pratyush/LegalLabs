import pg from "pg";
import type { SecretBox } from "../admin-models/secrets.js";
import type { Documents } from "../documents/documents.js";
import type { Notifier } from "../notifications/notify.js";
import type { Vaults } from "../vaults/vaults.js";
import { createSyncEngine } from "./engine.js";
import { createGoogleDrive } from "./google-drive.js";
import { createSyncScheduler } from "./scheduler.js";
import { createSyncService } from "./service.js";
import { createSharePoint } from "./sharepoint.js";
import type { SyncProvider, SyncProviderId } from "./types.js";

export interface SyncModuleOptions {
  secrets?: SecretBox;
  vaults: Vaults;
  notifier: Notifier;
  /** Builds a Documents over the pool it is given: the engine needs its own write-enabled pool. */
  documentsFor: (pool: pg.Pool) => Documents;
  env?: Record<string, string | undefined>;
  log?: (line: string) => void;
}

/**
 * Providers come from the environment: LEGALLABS_GOOGLE_CLIENT_ID/_SECRET and
 * LEGALLABS_MICROSOFT_CLIENT_ID/_SECRET (+ optional _TENANT). One that isn't set is simply not
 * offered. Without LEGALLABS_SECRETS_KEY nothing can be connected.
 */
export function createSyncModule(pool: pg.Pool, options: SyncModuleOptions) {
  const env = options.env ?? process.env;
  const providers: Partial<Record<SyncProviderId, SyncProvider>> = {};
  const http = { fetch: (url: string, init?: RequestInit) => fetch(url, init) };
  if (env.LEGALLABS_GOOGLE_CLIENT_ID && env.LEGALLABS_GOOGLE_CLIENT_SECRET) {
    providers.google_drive = createGoogleDrive({
      ...http,
      clientId: env.LEGALLABS_GOOGLE_CLIENT_ID,
      clientSecret: env.LEGALLABS_GOOGLE_CLIENT_SECRET,
    });
  }
  if (env.LEGALLABS_MICROSOFT_CLIENT_ID && env.LEGALLABS_MICROSOFT_CLIENT_SECRET) {
    providers.sharepoint = createSharePoint({
      ...http,
      clientId: env.LEGALLABS_MICROSOFT_CLIENT_ID,
      clientSecret: env.LEGALLABS_MICROSOFT_CLIENT_SECRET,
      ...(env.LEGALLABS_MICROSOFT_TENANT ? { tenant: env.LEGALLABS_MICROSOFT_TENANT } : {}),
    });
  }
  // Only this pool's sessions may write into a synced (read-only) vault.
  const writerPool = new pg.Pool({
    ...(pool as unknown as { options: pg.PoolConfig }).options,
    options: "-c legallabs.sync_writer=on",
    max: 3,
  });
  let scheduler: ReturnType<typeof createSyncScheduler> | null = null;
  const service = createSyncService(pool, {
    ...(options.secrets ? { secrets: options.secrets } : {}),
    providers,
    vaults: options.vaults,
    kick: () => void scheduler?.tick(),
  });
  if (options.secrets) {
    const engine = createSyncEngine({
      pool: writerPool,
      documents: options.documentsFor(writerPool),
      secrets: options.secrets,
      providers,
      notifier: options.notifier,
      ...(options.log ? { log: options.log } : {}),
    });
    scheduler = createSyncScheduler(writerPool, engine, options.log ? { log: options.log } : {});
  }
  return {
    service,
    scheduler,
    async stop() {
      await scheduler?.stop();
      await writerPool.end();
    },
  };
}
