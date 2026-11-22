import type pg from "pg";
import type { SecretBox } from "../admin-models/secrets.js";
import type { Client, Principal } from "../auth/auth.js";
import { asApp } from "../db.js";
import type { Vault, Vaults } from "../vaults/vaults.js";
import { createCredentials } from "./credentials.js";
import {
  ProviderError,
  type RemoteItem,
  type Scope,
  type SearchHit,
  type SyncProvider,
  type SyncProviderId,
} from "./types.js";

export interface Connection {
  id: string;
  provider: SyncProviderId;
  accountLabel: string;
  status: "active" | "needs_reauth" | "revoked";
  createdAt: string;
}

export interface SyncStatus {
  vaultId: string;
  provider: SyncProviderId;
  connectionId: string;
  rootRemoteId: string;
  rootName: string;
  cadenceMinutes: 15 | 60 | 1440;
  status: "pending" | "syncing" | "ok" | "sync_error";
  lastSyncAt: string | null;
  lastAttemptAt: string | null;
  lastErrorCode: string | null;
  lastError: string | null;
  lastCounts: Record<string, number>;
  skipped: { name: string; reason: string }[];
}

export type SyncRefusal =
  | "SYNC_UNAVAILABLE"
  | "PROVIDER_NOT_CONFIGURED"
  | "BAD_STATE"
  | "NOT_FOUND"
  | "CONNECTION_NEEDS_REAUTH"
  | "SYNC_TOO_SOON"
  | "IMPORT_TARGET_SYNCED"
  | "PROVIDER_ERROR"
  | "MATTER_NOT_FOUND"
  | "MATTER_REQUIRED_FOR_VAULT"
  | "MATTER_NOT_ALLOWED_FOR_VAULT"
  | "FORBIDDEN";
type Result<T> = { ok: true; value: T } | { ok: false; reason: SyncRefusal };

export interface SyncServiceOptions {
  secrets?: SecretBox;
  providers: Partial<Record<SyncProviderId, SyncProvider>>;
  vaults: Vaults;
  /** Asked to run due syncs now; the scheduler's tick. */
  kick?: () => void;
  now?: () => number;
}

const MIN_GAP_MS = 5 * 60_000;
const STATE_TTL_MS = 10 * 60_000;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createSyncService(pool: pg.Pool, options: SyncServiceOptions) {
  const { secrets, providers, vaults } = options;
  const now = options.now ?? Date.now;
  const credentials = secrets ? createCredentials(pool, secrets, now) : null;

  const need = (provider: string): SyncProvider | null =>
    providers[provider as SyncProviderId] ?? null;

  // The OAuth `state` is sealed (authenticated encryption), so it can't be forged or replayed
  // by another person: it names the user, provider and an expiry.
  const sealState = (p: Principal, provider: SyncProviderId) =>
    (secrets as SecretBox)
      .seal(JSON.stringify({ u: p.userId, p: provider, exp: now() + STATE_TTL_MS }))
      .toString("base64url");
  const openState = (p: Principal, state: string): SyncProviderId | null => {
    try {
      const v = JSON.parse((secrets as SecretBox).open(Buffer.from(state, "base64url"))) as {
        u: string;
        p: SyncProviderId;
        exp: number;
      };
      return v.u === p.userId && v.exp > now() ? v.p : null;
    } catch {
      return null;
    }
  };

  async function connectionRow(p: Principal, id: string) {
    if (!ID.test(id)) return null;
    return asApp(pool, p, async (db) => {
      const { rows } = await db.query<{
        id: string;
        provider: SyncProviderId;
        secret_ref: string;
        status: Connection["status"];
      }>("select id, provider, secret_ref, status from content.sync_connection where id = $1", [
        id,
      ]);
      return rows[0] ?? null;
    });
  }

  // Runs one provider call as the connection's owner; failures surface as refusals.
  async function withConnection<T>(
    p: Principal,
    connectionId: string,
    f: (provider: SyncProvider, run: <R>(g: (t: string) => Promise<R>) => Promise<R>) => Promise<T>,
  ): Promise<Result<T>> {
    if (!credentials) return { ok: false, reason: "SYNC_UNAVAILABLE" };
    const conn = await connectionRow(p, connectionId);
    if (!conn) return { ok: false, reason: "NOT_FOUND" };
    if (conn.status !== "active") return { ok: false, reason: "CONNECTION_NEEDS_REAUTH" };
    const provider = need(conn.provider);
    if (!provider) return { ok: false, reason: "PROVIDER_NOT_CONFIGURED" };
    try {
      const run = await credentials.session(p.workspaceId, conn.secret_ref, provider);
      return { ok: true, value: await f(provider, run) };
    } catch (err) {
      if (err instanceof ProviderError) {
        if (err.code === "AUTH_REVOKED") {
          await asApp(pool, p, (db) =>
            db.query(
              "update content.sync_connection set status = 'needs_reauth', updated_at = now() where id = $1",
              [connectionId],
            ),
          );
          return { ok: false, reason: "CONNECTION_NEEDS_REAUTH" };
        }
        return { ok: false, reason: "PROVIDER_ERROR" };
      }
      throw err;
    }
  }

  const toStatus = (r: Record<string, unknown>, skipped: SyncStatus["skipped"]): SyncStatus => ({
    vaultId: r.vault_id as string,
    provider: r.provider as SyncProviderId,
    connectionId: r.connection_id as string,
    rootRemoteId: r.root_remote_id as string,
    rootName: r.root_name as string,
    cadenceMinutes: r.cadence_minutes as 15 | 60 | 1440,
    status: r.status as SyncStatus["status"],
    lastSyncAt: r.last_sync_at ? new Date(r.last_sync_at as string).toISOString() : null,
    lastAttemptAt: r.last_attempt_at ? new Date(r.last_attempt_at as string).toISOString() : null,
    lastErrorCode: (r.last_error_code as string | null) ?? null,
    lastError: (r.last_error as string | null) ?? null,
    lastCounts: r.last_counts as Record<string, number>,
    skipped,
  });

  async function status(p: Principal, vaultId: string): Promise<SyncStatus | null> {
    if (!ID.test(vaultId)) return null;
    return asApp(pool, p, async (db) => {
      const { rows } = await db.query("select * from content.vault_sync where vault_id = $1", [
        vaultId,
      ]);
      if (!rows[0]) return null;
      const skipped = await db.query<{ name: string; skip_reason: string }>(
        `select name, skip_reason from content.sync_item
          where vault_id = $1 and state = 'skipped' order by name limit 200`,
        [vaultId],
      );
      return toStatus(
        rows[0],
        skipped.rows.map((s) => ({ name: s.name, reason: s.skip_reason })),
      );
    });
  }

  return {
    providersAvailable: () => Object.keys(providers) as SyncProviderId[],
    status,

    async authorize(
      p: Principal,
      providerId: string,
      redirectUri: string,
    ): Promise<Result<{ url: string }>> {
      if (!secrets) return { ok: false, reason: "SYNC_UNAVAILABLE" };
      const provider = need(providerId);
      if (!provider) return { ok: false, reason: "PROVIDER_NOT_CONFIGURED" };
      return {
        ok: true,
        value: { url: provider.authorizeUrl(sealState(p, provider.id), redirectUri) },
      };
    },

    /** Finishes the OAuth round trip: trades the code for tokens and seals them. */
    async connect(
      p: Principal,
      input: { code: string; state: string; redirectUri: string },
    ): Promise<Result<Connection>> {
      if (!secrets) return { ok: false, reason: "SYNC_UNAVAILABLE" };
      const providerId = openState(p, input.state);
      if (!providerId) return { ok: false, reason: "BAD_STATE" };
      const provider = need(providerId);
      if (!provider) return { ok: false, reason: "PROVIDER_NOT_CONFIGURED" };
      let granted: Awaited<ReturnType<SyncProvider["exchangeCode"]>>;
      try {
        granted = await provider.exchangeCode(input.code, input.redirectUri);
      } catch (err) {
        if (err instanceof ProviderError) return { ok: false, reason: "PROVIDER_ERROR" };
        throw err;
      }
      const ref = secrets.newRef();
      const { accountLabel, ...set } = granted;
      const blob = secrets.seal(JSON.stringify(set));
      return asApp(pool, p, async (db) => {
        await db.query("select content.store_sync_secret($1, $2)", [ref, blob]);
        const { rows } = await db.query<{ id: string; created_at: Date }>(
          `insert into content.sync_connection
             (workspace_id, user_id, provider, account_label, secret_ref)
           values ($1, $2, $3, $4, $5) returning id, created_at`,
          [p.workspaceId, p.userId, providerId, accountLabel.slice(0, 320), ref],
        );
        const r = rows[0];
        if (!r) throw new Error("insert returned no connection");
        return {
          ok: true as const,
          value: {
            id: r.id,
            provider: providerId,
            accountLabel,
            status: "active" as const,
            createdAt: r.created_at.toISOString(),
          },
        };
      });
    },

    async connections(p: Principal): Promise<Connection[]> {
      return asApp(pool, p, async (db) => {
        const { rows } = await db.query<{
          id: string;
          provider: SyncProviderId;
          account_label: string;
          status: Connection["status"];
          created_at: Date;
        }>(
          "select id, provider, account_label, status, created_at from content.sync_connection order by created_at",
        );
        return rows.map((r) => ({
          id: r.id,
          provider: r.provider,
          accountLabel: r.account_label,
          status: r.status,
          createdAt: r.created_at.toISOString(),
        }));
      });
    },

    /** False if it isn't the caller's, or a synced vault still depends on it. */
    async unlink(p: Principal, id: string): Promise<boolean> {
      if (!ID.test(id)) return false;
      return asApp(
        pool,
        p,
        async (db) =>
          (await db.query<{ ok: boolean }>("select content.unlink_sync_connection($1) ok", [id]))
            .rows[0]?.ok ?? false,
      );
    },

    /** One level of a folder, for the picker. */
    browse(
      p: Principal,
      connectionId: string,
      where: { driveId: string | null; folderId: string | null },
    ) {
      return withConnection(p, connectionId, (provider, run) =>
        run((t) => provider.browse(t, where)).then((items) => items.map(publicItem)),
      );
    },

    /** The connector search tool: hits cite `url`, and a quote is verified by fetching. */
    search(p: Principal, connectionId: string, driveId: string | null, query: string) {
      return withConnection<SearchHit[]>(p, connectionId, (provider, run) =>
        run((t) => provider.search(t, driveId, query)),
      );
    },

    /** Makes a read-only vault that mirrors the picked folder; the first sync is queued. */
    async createSyncedVault(
      p: Principal,
      input: {
        connectionId: string;
        driveId: string | null;
        folderId: string;
        name: string;
        cadenceMinutes?: 15 | 60 | 1440;
        matterId?: string | null;
      },
      client: Client,
    ): Promise<Result<{ vault: Vault; sync: SyncStatus }>> {
      const folder = await withConnection(p, input.connectionId, async (provider, run) => {
        const scope: Scope = { driveId: input.driveId, rootId: input.folderId };
        const item = await run((t) => provider.getItem(t, scope, input.folderId));
        return item;
      });
      if (!folder.ok) return folder;
      if (!folder.value || folder.value.kind !== "folder")
        return { ok: false, reason: "NOT_FOUND" };
      const conn = await connectionRow(p, input.connectionId);
      if (!conn) return { ok: false, reason: "NOT_FOUND" };
      const made = await vaults.create(
        p,
        { name: input.name, matterId: input.matterId ?? null },
        client,
      );
      if (!made.ok) return { ok: false, reason: made.reason as SyncRefusal };
      await asApp(pool, p, (db) =>
        db.query(
          `insert into content.vault_sync
             (vault_id, workspace_id, connection_id, provider, drive_id, root_remote_id,
              root_name, cadence_minutes)
           values ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            made.value.id,
            p.workspaceId,
            input.connectionId,
            conn.provider,
            input.driveId,
            input.folderId,
            folder.value?.name ?? "",
            input.cadenceMinutes ?? 60,
          ],
        ),
      );
      options.kick?.();
      const sync = await status(p, made.value.id);
      if (!sync) throw new Error("sync row vanished");
      return { ok: true, value: { vault: made.value, sync } };
    },

    async setCadence(p: Principal, vaultId: string, minutes: 15 | 60 | 1440): Promise<boolean> {
      if (!ID.test(vaultId)) return false;
      return asApp(
        pool,
        p,
        async (db) =>
          ((
            await db.query(
              `update content.vault_sync set cadence_minutes = $2, updated_at = now()
                where vault_id = $1`,
              [vaultId, minutes],
            )
          ).rowCount ?? 0) > 0,
      );
    },

    /** At most one manual sync per five minutes per vault; the scheduler runs it. */
    async syncNow(p: Principal, vaultId: string): Promise<Result<SyncStatus>> {
      if (!ID.test(vaultId)) return { ok: false, reason: "NOT_FOUND" };
      const gate = await asApp(pool, p, async (db) => {
        const { rows } = await db.query<{ last: Date | null; status: string }>(
          "select last_attempt_at last, status from content.vault_sync where vault_id = $1",
          [vaultId],
        );
        const r = rows[0];
        if (!r) return "NOT_FOUND" as const;
        if (r.status === "syncing") return "OK" as const;
        if (r.last && now() - r.last.getTime() < MIN_GAP_MS) return "SYNC_TOO_SOON" as const;
        const upd = await db.query(
          "update content.vault_sync set next_run_at = now(), updated_at = now() where vault_id = $1",
          [vaultId],
        );
        return (upd.rowCount ?? 0) > 0 ? ("OK" as const) : ("FORBIDDEN" as const);
      });
      if (gate !== "OK") return { ok: false, reason: gate };
      options.kick?.();
      const s = await status(p, vaultId);
      return s ? { ok: true, value: s } : { ok: false, reason: "NOT_FOUND" };
    },

    /** A one-off copy of picked files or folders into an ordinary vault. */
    async importItems(
      p: Principal,
      input: {
        connectionId: string;
        driveId: string | null;
        itemIds: string[];
        vaultId: string;
        folderId: string | null;
      },
      client: Client,
    ): Promise<Result<{ imported: number; skipped: number }>> {
      if (await status(p, input.vaultId)) return { ok: false, reason: "IMPORT_TARGET_SYNCED" };
      const out = { imported: 0, skipped: 0 };
      const res = await withConnection(p, input.connectionId, async (provider, run) => {
        for (const id of input.itemIds.slice(0, 200)) {
          const scope: Scope = { driveId: input.driveId, rootId: id };
          const item = await run((t) => provider.getItem(t, scope, id));
          if (!item) {
            out.skipped++;
            continue;
          }
          // A folder keeps its structure: each file lands under its relative path.
          const files: { item: RemoteItem; path: string }[] = [];
          if (item.kind === "folder") {
            const tree = await run((t) => provider.listTree(t, scope));
            const byId = new Map([[item.id, { ...item, parentIds: [] as string[] }]]);
            for (const f of tree) byId.set(f.id, f);
            const pathOf = (f: RemoteItem): string => {
              const names: string[] = [];
              let cur = f.parentIds[0] ? byId.get(f.parentIds[0]) : undefined;
              while (cur) {
                names.unshift(cur.name);
                cur = cur.parentIds[0] ? byId.get(cur.parentIds[0]) : undefined;
              }
              return names.join("/");
            };
            for (const f of tree) if (f.kind === "file") files.push({ item: f, path: pathOf(f) });
          } else files.push({ item, path: "" });
          for (const f of files) {
            const dl = await run((t) => provider.download(t, scope, f.item));
            if (!dl) {
              out.skipped++;
              continue;
            }
            const up = await vaults.upload(
              p,
              input.vaultId,
              {
                name: dl.name,
                bytes: dl.bytes,
                folderId: input.folderId,
                ...(f.path ? { relativePath: f.path } : {}),
              },
              client,
            );
            if (up.ok) out.imported++;
            else out.skipped++;
          }
        }
        return out;
      });
      return res;
    },
  };
}

function publicItem(i: RemoteItem) {
  return {
    id: i.id,
    name: i.name,
    kind: i.kind,
    mime: i.mime,
    size: i.size,
    modified_at: i.modifiedAt,
    url: i.webUrl,
  };
}

export type SyncService = ReturnType<typeof createSyncService>;
