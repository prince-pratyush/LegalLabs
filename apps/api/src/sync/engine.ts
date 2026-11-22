import { fileTypeLimit } from "@legallabs/contracts";
import type pg from "pg";
import type { SecretBox } from "../admin-models/secrets.js";
import type { Principal } from "../auth/auth.js";
import { asApp, asWorker } from "../db.js";
import { type Documents, MAX_FILE_BYTES } from "../documents/documents.js";
import { type Notifier, noNotifier } from "../notifications/notify.js";
import { createCredentials } from "./credentials.js";
import {
  ProviderError,
  type RemoteChange,
  type RemoteItem,
  type Scope,
  type SyncProvider,
  type SyncProviderId,
} from "./types.js";

export interface Counts {
  created: number;
  updated: number;
  renamed: number;
  moved: number;
  deleted: number;
  skipped: number;
  failed: number;
  folders: number;
}

export type SyncOutcome =
  | { status: "ok"; counts: Counts; full: boolean }
  | { status: "busy" }
  | { status: "sync_error"; code: string; message: string };

export interface SyncEngineOptions {
  /** Its sessions start with legallabs.sync_writer = on, so the read-only guard lets them in. */
  pool: pg.Pool;
  /** Built on `pool`, so every write the engine makes passes the guard. */
  documents: Documents;
  secrets: SecretBox;
  providers: Partial<Record<SyncProviderId, SyncProvider>>;
  notifier?: Notifier;
  now?: () => number;
  log?: (line: string) => void;
}

interface Row {
  vault_id: string;
  workspace_id: string;
  connection_id: string;
  provider: SyncProviderId;
  drive_id: string | null;
  root_remote_id: string;
  change_token: string | null;
  cadence_minutes: number;
  secret_ref: string;
  vault_name: string;
  matter_id: string | null;
}

interface Item {
  kind: "folder" | "file";
  parent_remote_id: string | null;
  name: string;
  document_id: string | null;
  folder_id: string | null;
  remote_version: string | null;
  state: "synced" | "skipped" | "failed";
}

const STALE_LOCK_MINUTES = 30;
const emptyCounts = (): Counts => ({
  created: 0,
  updated: 0,
  renamed: 0,
  moved: 0,
  deleted: 0,
  skipped: 0,
  failed: 0,
  folders: 0,
});

export function createSyncEngine(options: SyncEngineOptions) {
  const { pool, documents, providers } = options;
  const credentials = createCredentials(pool, options.secrets, options.now);
  const notifier = options.notifier ?? noNotifier;
  const log = options.log ?? (() => {});
  const client = { ip: null, userAgent: "sync-worker" };

  async function run(vaultId: string, workspaceId: string, ownerId: string): Promise<SyncOutcome> {
    const principal: Principal = { sessionId: "sync", userId: ownerId, workspaceId };
    const as = <T>(work: (db: pg.PoolClient) => Promise<T>) => asApp(pool, principal, work);

    // One run per vault: the claim only succeeds if no run holds it (or the holder died).
    const row = await as(async (db) => {
      const { rows } = await db.query<Row>(
        `with claimed as (
           update content.vault_sync s
              set status = 'syncing', last_attempt_at = now(), updated_at = now()
            where s.vault_id = $1
              and (s.status <> 'syncing'
                   or s.last_attempt_at < now() - make_interval(mins => $2))
           returning s.*)
         select c.vault_id, c.workspace_id, c.connection_id, c.provider, c.drive_id,
                c.root_remote_id, c.change_token, c.cadence_minutes, k.secret_ref,
                v.name vault_name, v.matter_id
           from claimed c
           join content.sync_connection k on k.id = c.connection_id
           join content.vault v on v.id = c.vault_id`,
        [vaultId, STALE_LOCK_MINUTES],
      );
      return rows[0] ?? null;
    });
    if (!row) return { status: "busy" };

    const counts = emptyCounts();
    try {
      const provider = providers[row.provider];
      if (!provider) throw new ProviderError("UPSTREAM", "This provider is not configured.");
      const scope: Scope = { driveId: row.drive_id, rootId: row.root_remote_id };
      const guard = await credentials.session(row.workspace_id, row.secret_ref, provider);
      // Losing access to the folder must not look like "everything was deleted": Drive reports
      // a revoked folder's files as removed, so the root is checked before any change applies.
      if (!(await guard((t) => provider.getItem(t, scope, row.root_remote_id)))) {
        throw new ProviderError("ACCESS_REVOKED", "The synced folder is no longer reachable.", 404);
      }

      const known = new Map<string, Item>();
      for (const r of (
        await as((db) =>
          db.query<Item & { remote_id: string }>(
            `select remote_id, kind, parent_remote_id, name, document_id, folder_id,
                    remote_version, state from content.sync_item where vault_id = $1`,
            [vaultId],
          ),
        )
      ).rows) {
        known.set(r.remote_id, r);
      }

      const writer = createWriter({ as, known, row, principal, counts, scope, provider, guard });
      let full = row.change_token === null;
      let nextToken: string;
      if (!full) {
        try {
          const token = row.change_token as string;
          const res = await guard((t) => provider.changes(t, scope, token));
          nextToken = res.nextToken;
          await writer.retryFailed();
          await writer.applyChanges(res.changes);
        } catch (err) {
          if (!(err instanceof ProviderError) || err.code !== "CHANGE_TOKEN_INVALID") throw err;
          full = true; // the token aged out: list the whole folder again
        }
      }
      if (full) {
        // The token first, so a change made while listing is seen by the next run.
        nextToken = await guard((t) => provider.startToken(t, scope));
        const items = await guard((t) => provider.listTree(t, scope));
        await writer.applyFull(items);
      }
      // biome-ignore lint/style/noNonNullAssertion: set on both branches above
      const token = nextToken!;
      await as(async (db) => {
        await db.query(
          `update content.vault_sync
              set status = 'ok', change_token = $2, last_sync_at = now(), last_error = null,
                  last_error_code = null, last_counts = $3, updated_at = now(),
                  next_run_at = now() + make_interval(mins => cadence_minutes)
            where vault_id = $1`,
          [vaultId, token, JSON.stringify(counts)],
        );
        await db.query(
          "select admin.append_audit_event('sync.completed', 'user', $1, 'vault', $2, $3, null, null)",
          [ownerId, vaultId, JSON.stringify({ ...counts, full })],
        );
      });
      return { status: "ok", counts, full };
    } catch (err) {
      const code = err instanceof ProviderError ? err.code : "INTERNAL";
      const message = err instanceof Error ? err.message.slice(0, 300) : "Sync failed.";
      log(`sync ${vaultId} failed: ${code}`);
      await as(async (db) => {
        await db.query(
          `update content.vault_sync
              set status = 'sync_error', last_error_code = $2, last_error = $3,
                  last_counts = $4, updated_at = now(),
                  next_run_at = now() + make_interval(mins => greatest(cadence_minutes, 15))
            where vault_id = $1`,
          [vaultId, code, message, JSON.stringify(counts)],
        );
        await db.query(
          "select admin.append_audit_event('sync.failed', 'user', $1, 'vault', $2, $3, null, null)",
          [ownerId, vaultId, JSON.stringify({ code })],
        );
      });
      // Existing documents stay readable; only the person's connection needs attention.
      if (code === "AUTH_REVOKED" || code === "ACCESS_REVOKED") {
        await asWorker(pool, (w) =>
          w.query("select content.sync_connection_state($1, $2, 'needs_reauth', $3)", [
            workspaceId,
            row.connection_id,
            code,
          ]),
        ).catch(() => {});
      }
      await notifier.notify(principal, {
        kind: "vault.sync_failed",
        actorId: null,
        objectType: "vault",
        objectId: vaultId,
        objectTitle: row.vault_name,
        matterId: row.matter_id,
        people: { owner: ownerId },
      });
      return { status: "sync_error", code, message };
    }
  }

  interface WriterCtx {
    as: <T>(work: (db: pg.PoolClient) => Promise<T>) => Promise<T>;
    known: Map<string, Item>;
    row: Row;
    principal: Principal;
    counts: Counts;
    scope: Scope;
    provider: SyncProvider;
    guard: <T>(f: (token: string) => Promise<T>) => Promise<T>;
  }

  function createWriter(ctx: WriterCtx) {
    const { as, known, row, principal, counts, scope, provider, guard } = ctx;

    const saveItem = (remoteId: string, it: Item) => {
      known.set(remoteId, it);
      return as((db) =>
        db.query(
          `insert into content.sync_item
             (vault_id, remote_id, workspace_id, kind, parent_remote_id, name, document_id,
              folder_id, remote_version, state)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           on conflict (vault_id, remote_id) do update set
             kind = excluded.kind, parent_remote_id = excluded.parent_remote_id,
             name = excluded.name, document_id = excluded.document_id,
             folder_id = excluded.folder_id, remote_version = excluded.remote_version,
             state = excluded.state`,
          [
            row.vault_id,
            remoteId,
            row.workspace_id,
            it.kind,
            it.parent_remote_id,
            it.name,
            it.document_id,
            it.folder_id,
            it.remote_version,
            it.state,
          ],
        ),
      );
    };

    // The first parent that is the root or a folder already in the vault.
    function parentOf(item: RemoteItem) {
      for (const pid of item.parentIds) {
        if (pid === row.root_remote_id) return { remote: pid, folderId: null as string | null };
        const p = known.get(pid);
        if (p?.kind === "folder" && p.folder_id) return { remote: pid, folderId: p.folder_id };
      }
      return null;
    }

    // Bins a folder and everything under it, or one file.
    async function removeSubtree(remoteId: string) {
      const ids: string[] = [];
      const queue = [remoteId];
      while (queue.length > 0) {
        const id = queue.shift() as string;
        ids.push(id);
        for (const [k, v] of known) if (v.parent_remote_id === id) queue.push(k);
      }
      const docs: string[] = [];
      const folders: string[] = [];
      for (const id of ids) {
        const it = known.get(id);
        if (!it) continue;
        if (it.kind === "file") {
          if (it.document_id) docs.push(it.document_id);
          if (it.state !== "skipped") counts.deleted++;
        } else if (it.folder_id) folders.push(it.folder_id);
      }
      await as(async (db) => {
        await db.query("select content.trash_items($1, $2::uuid[], $3::uuid[])", [
          row.vault_id,
          docs,
          folders,
        ]);
        await db.query(
          "delete from content.sync_item where vault_id = $1 and remote_id = any($2)",
          [row.vault_id, ids],
        );
      });
      for (const id of ids) known.delete(id);
    }

    async function applyFolder(
      item: RemoteItem,
      parent: { remote: string; folderId: string | null },
    ) {
      const existing = known.get(item.id);
      if (!existing?.folder_id) {
        const folderId = await as(async (db) => {
          for (let n = 0; n < 20; n++) {
            const name =
              (n === 0 ? item.name : `${item.name} (${n + 1})`).slice(0, 255) || "Folder";
            const { rows } = await db.query<{ id: string }>(
              `insert into content.folder (workspace_id, vault_id, parent_id, name, created_by)
               values ($1, $2, $3, $4, $5)
               on conflict (vault_id, coalesce(parent_id, vault_id), lower(name))
                 where deleted_at is null do nothing returning id`,
              [row.workspace_id, row.vault_id, parent.folderId, name, principal.userId],
            );
            if (rows[0]) return rows[0].id;
          }
          throw new Error("no free folder name");
        });
        counts.folders++;
        await saveItem(item.id, {
          kind: "folder",
          parent_remote_id: parent.remote,
          name: item.name,
          document_id: null,
          folder_id: folderId,
          remote_version: null,
          state: "synced",
        });
        return true;
      }
      const renamed = existing.name !== item.name;
      const moved = existing.parent_remote_id !== parent.remote;
      if (renamed || moved) {
        await as((db) =>
          db.query(`update content.folder set name = $2, parent_id = $3 where id = $1`, [
            existing.folder_id,
            item.name.slice(0, 255),
            parent.folderId,
          ]),
        );
        if (renamed) counts.renamed++;
        if (moved) counts.moved++;
        await saveItem(item.id, { ...existing, name: item.name, parent_remote_id: parent.remote });
      }
      return false;
    }

    async function applyFile(
      item: RemoteItem,
      parent: { remote: string; folderId: string | null },
    ) {
      const existing = known.get(item.id);
      const base: Item = {
        kind: "file",
        parent_remote_id: parent.remote,
        name: item.name,
        document_id: existing?.document_id ?? null,
        folder_id: null,
        remote_version: item.version,
        state: "synced",
      };
      const skip = async (reason: string) => {
        counts.skipped++;
        await as((db) =>
          db.query(
            `insert into content.sync_item
               (vault_id, remote_id, workspace_id, kind, parent_remote_id, name, document_id,
                folder_id, remote_version, state, skip_reason)
             values ($1, $2, $3, 'file', $4, $5, $6, null, $7, 'skipped', $8)
             on conflict (vault_id, remote_id) do update set
               parent_remote_id = excluded.parent_remote_id, name = excluded.name,
               remote_version = excluded.remote_version, state = 'skipped',
               skip_reason = excluded.skip_reason`,
            [
              row.vault_id,
              item.id,
              row.workspace_id,
              parent.remote,
              item.name,
              base.document_id,
              item.version,
              reason,
            ],
          ),
        );
        known.set(item.id, { ...base, state: "skipped" });
      };

      const unchanged =
        existing?.document_id &&
        existing.remote_version === item.version &&
        existing.state === "synced";
      if (unchanged && existing) {
        // Only the place or the name moved.
        const doc = await as(
          async (db) =>
            (
              await db.query<{ name: string; folder_id: string | null }>(
                "select name, folder_id from content.document where id = $1",
                [existing.document_id],
              )
            ).rows[0],
        );
        if (!doc) return;
        const folderMoved = existing.parent_remote_id !== parent.remote;
        const renamed = existing.name !== item.name;
        if (folderMoved || renamed) {
          // Keep an export suffix such as .docx that the remote name does not carry.
          const suffix = doc.name.startsWith(existing.name)
            ? doc.name.slice(existing.name.length)
            : "";
          await as((db) =>
            db.query(
              "update content.document set name = $2, folder_id = $3, updated_at = now() where id = $1",
              [existing.document_id, `${item.name}${suffix}`.slice(0, 255), parent.folderId],
            ),
          );
          if (folderMoved) counts.moved++;
          if (renamed) counts.renamed++;
          await saveItem(item.id, {
            ...existing,
            name: item.name,
            parent_remote_id: parent.remote,
          });
        }
        return;
      }

      if (item.size !== null && item.size > MAX_FILE_BYTES) return skip("FILE_TOO_LARGE");
      const typeLimit = fileTypeLimit(item.name)?.bytes;
      if (item.size !== null && typeLimit !== undefined && item.size > typeLimit) {
        return skip("FILE_TOO_LARGE");
      }
      let dl: Awaited<ReturnType<SyncProvider["download"]>>;
      try {
        dl = await guard((t) => provider.download(t, scope, item));
      } catch (err) {
        if (
          err instanceof ProviderError &&
          (err.code === "AUTH_REVOKED" ||
            (err.code === "ACCESS_REVOKED" && err.status !== 404 && err.status !== 403))
        ) {
          throw err;
        }
        // One bad file does not stop the folder; it is retried next run.
        counts.failed++;
        await saveItem(item.id, { ...base, remote_version: null, state: "failed" });
        return;
      }
      if (!dl) return skip("UNSUPPORTED_TYPE");
      const common = { name: dl.name, bytes: dl.bytes };
      const place = { matterId: row.matter_id, vaultId: row.vault_id, folderId: parent.folderId };
      const upload = async () => {
        const res = await documents.upload(principal, { ...common, ...place }, client);
        if (!res.ok) return res.reason;
        counts.created++;
        await saveItem(item.id, { ...base, document_id: res.document.id });
        return null;
      };

      if (existing?.document_id) {
        const res = await documents.replace(principal, existing.document_id, common, client);
        if (res.ok) {
          counts.updated++;
          // A change of name or place rides along with the new version.
          await as((db) =>
            db.query(
              "update content.document set name = $2, folder_id = $3, updated_at = now() where id = $1",
              [existing.document_id, dl.name.slice(0, 255), parent.folderId],
            ),
          );
          await saveItem(item.id, { ...base, document_id: existing.document_id });
          return;
        }
        if (res.reason === "UNSUPPORTED_TYPE") {
          // The file changed type, which one document may not do: the old one goes to the bin.
          await as((db) =>
            db.query("select content.trash_items($1, $2::uuid[], '{}'::uuid[])", [
              row.vault_id,
              [existing.document_id],
            ]),
          );
          const failure = await upload();
          if (failure) return skip(failure);
          return;
        }
        return skip(res.reason);
      }
      const failure = await upload();
      if (failure) await skip(failure);
    }

    // Folders before their children; what never finds a parent is outside the tree.
    async function upsert(items: RemoteItem[], fromChange: boolean) {
      let pending = [...items];
      const done = new Set<string>();
      for (;;) {
        let progress = false;
        const next: RemoteItem[] = [];
        for (const item of pending) {
          if (item.id === row.root_remote_id) continue;
          const parent = parentOf(item);
          if (!parent) {
            next.push(item);
            continue;
          }
          progress = true;
          if (item.kind === "folder") {
            const isNew = await applyFolder(item, parent);
            // A folder moved into the tree brings its contents, which no change lists.
            if (isNew && fromChange && !done.has(item.id)) {
              const inside = await guard((t) =>
                provider.listTree(t, { driveId: scope.driveId, rootId: item.id }),
              );
              next.push(...inside);
            }
          } else {
            await applyFile(item, parent);
          }
          done.add(item.id);
        }
        pending = next;
        if (!progress || pending.length === 0) break;
      }
      for (const item of pending) if (known.has(item.id)) await removeSubtree(item.id);
    }

    return {
      async applyChanges(changes: RemoteChange[]) {
        const present: RemoteItem[] = [];
        for (const c of changes) {
          if (c.removed) {
            if (c.id === row.root_remote_id) {
              throw new ProviderError("ACCESS_REVOKED", "The synced folder was removed.", 404);
            }
            if (known.has(c.id)) await removeSubtree(c.id);
          } else present.push(c.item);
        }
        // Several changes to one file collapse into the last.
        const last = new Map(present.map((i) => [i.id, i]));
        await upsert([...last.values()], true);
      },
      async applyFull(items: RemoteItem[]) {
        await upsert(items, false);
        const seen = new Set(items.map((i) => i.id));
        // Gone from the listing: removed while no token covered it.
        for (const id of [...known.keys()]) {
          if (known.has(id) && !seen.has(id)) await removeSubtree(id);
        }
      },
      // Files that failed last time are looked up again; the change that named them is spent.
      async retryFailed() {
        const again: RemoteItem[] = [];
        for (const [id, it] of [...known]) {
          if (it.state !== "failed") continue;
          const item = await guard((t) => provider.getItem(t, scope, id));
          if (item) again.push(item);
          else await removeSubtree(id);
        }
        if (again.length > 0) {
          // A failed file is retried as new content; clear the version so it is not "unchanged".
          await upsert(again, false);
        }
      },
    };
  }

  return { run };
}

export type SyncEngine = ReturnType<typeof createSyncEngine>;
