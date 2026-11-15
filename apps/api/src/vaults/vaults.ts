import {
  type ContentControls,
  type FileState,
  fileTypeLimit,
  hasAccess,
  type UploadRejection,
  type VaultAccess,
  type VaultGrant,
} from "@legallabs/contracts";
import { contentKey, type ObjectStore } from "@legallabs/storage";
import type pg from "pg";
import { type Client, type Principal, uaHash } from "../auth/auth.js";
import { asApp, RLS_REFUSED } from "../db.js";
import {
  type Documents,
  freeName,
  MAX_FILE_BYTES,
  type UploadResult,
} from "../documents/documents.js";

export interface Vault {
  id: string;
  name: string;
  description: string;
  matterId: string | null;
  ownerId: string;
  /** Null when an admin sees a vault they can't open. */
  access: VaultAccess | null;
  contentControls: ContentControls;
  retentionHours: number | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface VaultStats {
  files: number;
  bytes: number;
  /** Files a wall keeps from the caller: a count, never names. */
  hidden: number;
  queued: number;
  processing: number;
  ready: number;
  failed: number;
  maxFiles: number;
  maxBytes: number;
}

export interface Folder {
  id: string;
  name: string;
  parentId: string | null;
}

export interface VaultFile {
  id: string;
  versionId: string;
  folderId: string | null;
  name: string;
  mime: string;
  size: number;
  state: FileState;
  failureReason: string | null;
  pageCount: number | null;
  updatedAt: string;
}

export interface Tree {
  /** From the top of the vault down to the folder listed. */
  path: Folder[];
  folders: Folder[];
  files: VaultFile[];
  nextCursor: string | null;
}

export interface TreeQuery {
  folderId?: string | null;
  cursor?: string | null;
  /** Searches names across the whole vault instead of listing one folder. */
  q?: string;
  state?: FileState;
  limit?: number;
}

export interface BinItem {
  kind: "folder" | "document";
  id: string;
  name: string;
  deletedAt: string;
  deletedReason: "user" | "retention";
  /** When the purge job removes it for good. */
  purgeAt: string;
}

export interface Shares {
  grants: (VaultGrant & { name: string })[];
  workspaceView: boolean;
}

export interface ManifestFile {
  clientRef: string;
  name: string;
  size: number;
}

export interface Preflight {
  accepted: string[];
  rejected: { clientRef: string; reason: UploadRejection }[];
}

export interface AdminVault extends Vault {
  ownerEmail: string;
  files: number;
  bytes: number;
  grants: number;
}

export type Refusal = "NOT_FOUND" | "FORBIDDEN" | "CONFLICT" | "MATTER_NOT_FOUND";
type Result<T> = { ok: true; value: T } | { ok: false; reason: Refusal };

export interface Vaults {
  create(
    p: Principal,
    input: { name: string; description?: string; matterId?: string | null },
    client: Client,
  ): Promise<Result<Vault>>;
  list(p: Principal): Promise<(Vault & { files: number })[]>;
  get(p: Principal, id: string): Promise<{ vault: Vault; stats: VaultStats } | null>;
  update(
    p: Principal,
    id: string,
    patch: {
      name?: string;
      description?: string;
      retentionHours?: number | null;
      contentControls?: ContentControls;
    },
    client: Client,
  ): Promise<Result<Vault>>;
  remove(p: Principal, id: string, client: Client): Promise<boolean>;
  tree(p: Principal, id: string, query: TreeQuery): Promise<Tree | null>;
  createFolder(
    p: Principal,
    vaultId: string,
    input: { parentId: string | null; name: string },
    client: Client,
  ): Promise<Result<Folder>>;
  updateFolder(
    p: Principal,
    folderId: string,
    patch: { name?: string; parentId?: string | null },
    client: Client,
  ): Promise<Result<Folder>>;
  updateFile(
    p: Principal,
    documentId: string,
    patch: { name?: string; folderId?: string | null },
    client: Client,
  ): Promise<Result<{ id: string; name: string; folderId: string | null }>>;
  trash(
    p: Principal,
    vaultId: string,
    items: { documentIds: string[]; folderIds: string[] },
    client: Client,
  ): Promise<number | null>;
  restore(
    p: Principal,
    vaultId: string,
    items: { documentIds: string[]; folderIds: string[] },
    client: Client,
  ): Promise<number | null>;
  bin(p: Principal, vaultId: string): Promise<BinItem[] | null>;
  shares(p: Principal, vaultId: string): Promise<Shares | null>;
  setShares(
    p: Principal,
    vaultId: string,
    shares: { grants: VaultGrant[]; workspaceView: boolean },
    client: Client,
  ): Promise<{ deniedByWall: string[] } | null>;
  preflight(p: Principal, vaultId: string, files: ManifestFile[]): Promise<Preflight | null>;
  /** `relativePath` keeps a dropped folder's structure; missing folders are made. */
  upload(
    p: Principal,
    vaultId: string,
    input: { name: string; bytes: Uint8Array; folderId: string | null; relativePath?: string },
    client: Client,
  ): Promise<UploadResult | { ok: false; reason: "NOT_FOUND" }>;
  retentionEstimate(
    p: Principal,
    vaultId: string,
    hours: number,
  ): Promise<{ documents: number; earliestDeletionAt: string | null } | null>;
  findPrincipals(
    p: Principal,
    query: string,
  ): Promise<{ principalType: "user" | "group"; principalId: string; label: string }[]>;
  adminList(p: Principal): Promise<AdminVault[] | null>;
  transfer(
    p: Principal,
    vaultId: string,
    newOwnerId: string,
    client: Client,
  ): Promise<boolean | null>;
  restoreVault(p: Principal, vaultId: string, client: Client): Promise<boolean>;
  purge(p: Principal, vaultId: string, client: Client): Promise<boolean | null>;
}

export const BIN_DAYS = 30;
const PAGE = 200;
const MAX_PAGE = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isId = (id: string | null | undefined): id is string =>
  typeof id === "string" && UUID.test(id);

interface VaultRow {
  id: string;
  name: string;
  description: string;
  matter_id: string | null;
  owner_id: string;
  access: VaultAccess | null;
  content_controls: ContentControls;
  retention_hours: number | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

const VAULT_SQL = `
  select v.id, v.name, v.description, v.matter_id, v.owner_id, content.vault_level(v.id) access,
         v.content_controls, v.retention_hours, v.created_at, v.updated_at, v.deleted_at
    from content.vault v`;

const toVault = (row: VaultRow): Vault => ({
  id: row.id,
  name: row.name,
  description: row.description,
  matterId: row.matter_id,
  ownerId: row.owner_id,
  access: row.access,
  contentControls: row.content_controls,
  retentionHours: row.retention_hours,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
  deletedAt: row.deleted_at?.toISOString() ?? null,
});

const STATE_SQL = `case coalesce(j.status, 'indexed')
    when 'queued' then 'queued' when 'parsing' then 'processing'
    when 'indexed' then 'ready' else 'failed' end`;

const JOB_STATUS: Record<FileState, string> = {
  queued: "queued",
  processing: "parsing",
  ready: "indexed",
  failed: "failed",
};

interface FileRow {
  id: string;
  version_id: string;
  folder_id: string | null;
  name: string;
  mime: string;
  size: string;
  state: FileState;
  reason: string | null;
  page_count: number | null;
  updated_at: Date;
  sort: string;
}

const toFile = (row: FileRow): VaultFile => ({
  id: row.id,
  versionId: row.version_id,
  folderId: row.folder_id,
  name: row.name,
  mime: row.mime,
  size: Number(row.size),
  state: row.state,
  failureReason: row.reason,
  pageCount: row.page_count,
  updatedAt: row.updated_at.toISOString(),
});

const toFolder = (row: { id: string; name: string; parent_id: string | null }): Folder => ({
  id: row.id,
  name: row.name,
  parentId: row.parent_id,
});

// The cursor is the last row's sort key, so a page never skips or repeats a file.
const encodeCursor = (sort: string, id: string) =>
  Buffer.from(JSON.stringify([sort, id])).toString("base64url");
function decodeCursor(cursor: string | null | undefined): [string, string] | null {
  if (!cursor) return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString());
    if (Array.isArray(value) && typeof value[0] === "string" && isId(value[1])) {
      return [value[0], value[1]];
    }
  } catch {
    // An unreadable cursor starts from the top.
  }
  return null;
}

const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";
const codeOf = (err: unknown) => (err as { code?: string }).code;

export interface VaultsOptions {
  documents: Documents;
  store: ObjectStore;
}

export function createVaults(pool: pg.Pool, { documents, store }: VaultsOptions): Vaults {
  const audit = (
    db: pg.PoolClient,
    p: Principal,
    client: Client,
    action: string,
    type: string | null,
    id: string | null,
    details: object = {},
  ) =>
    db.query("select admin.append_audit_event($1, 'user', $2, $3, $4, $5, $6, $7)", [
      action,
      p.userId,
      type,
      id,
      JSON.stringify(details),
      client.ip,
      uaHash(client),
    ]);

  const level = async (db: pg.PoolClient, vaultId: string) =>
    (await db.query<{ l: VaultAccess | null }>("select content.vault_level($1) l", [vaultId]))
      .rows[0]?.l ?? null;

  const canEdit = (access: VaultAccess | null) => hasAccess(access, "edit");
  const canManage = (access: VaultAccess | null) => hasAccess(access, "full");

  async function getVault(db: pg.PoolClient, id: string) {
    const { rows } = await db.query<VaultRow>(`${VAULT_SQL} where v.id = $1`, [id]);
    return rows[0] ? toVault(rows[0]) : null;
  }

  // Finds or makes each folder on a path such as "Contracts/2024", from `parentId` down.
  async function ensurePath(
    db: pg.PoolClient,
    p: Principal,
    vaultId: string,
    parentId: string | null,
    path: string,
  ) {
    let current = parentId;
    for (const part of path
      .split("/")
      .map((s) => s.trim())
      .filter((s) => s !== "" && s !== "." && s !== "..")) {
      const name = part.slice(0, 255);
      await db.query(
        `insert into content.folder (workspace_id, vault_id, parent_id, name, created_by)
         values ($1, $2, $3, $4, $5)
         on conflict (vault_id, coalesce(parent_id, vault_id), lower(name)) where deleted_at is null
         do nothing`,
        [p.workspaceId, vaultId, current, name, p.userId],
      );
      const { rows } = await db.query<{ id: string }>(
        `select id from content.folder
          where vault_id = $1 and ${current ? "parent_id = $3" : "parent_id is null and $3::uuid is null"}
            and lower(name) = lower($2)`,
        [vaultId, name, current],
      );
      const found = rows[0]?.id;
      if (!found) throw new Error("folder vanished while it was made");
      current = found;
    }
    return current;
  }

  return {
    async create(p, input, client) {
      try {
        return await asApp(pool, p, async (db) => {
          const { rows } = await db.query<{ id: string }>(
            `insert into content.vault (workspace_id, owner_id, matter_id, name, description)
             values ($1, $2, $3, $4, $5) returning id`,
            [p.workspaceId, p.userId, input.matterId ?? null, input.name, input.description ?? ""],
          );
          const id = rows[0]?.id;
          if (!id) throw new Error("insert returned no vault");
          await audit(db, p, client, "vault.created", "vault", id, {
            matter_id: input.matterId ?? null,
          });
          const vault = await getVault(db, id);
          if (!vault) throw new Error("new vault is not readable");
          return { ok: true as const, value: vault };
        });
      } catch (err) {
        if (codeOf(err) === RLS_REFUSED) {
          // Either no permission or a matter the caller can't reach; both read as refusals.
          return { ok: false, reason: input.matterId ? "MATTER_NOT_FOUND" : "FORBIDDEN" };
        }
        if (codeOf(err) === "23503") return { ok: false, reason: "MATTER_NOT_FOUND" };
        throw err;
      }
    },

    async list(p) {
      return asApp(pool, p, async (db) => {
        const { rows } = await db.query<VaultRow & { files: string }>(
          `${VAULT_SQL.replace(
            "from content.vault v",
            `, (select count(*) from content.document d where d.vault_id = v.id) files
               from content.vault v`,
          )}
            where v.deleted_at is null and content.vault_level(v.id) is not null
            order by v.updated_at desc, v.id desc limit 500`,
        );
        return rows.map((row) => ({ ...toVault(row), files: Number(row.files) }));
      });
    },

    async get(p, id) {
      if (!isId(id)) return null;
      return asApp(pool, p, async (db) => {
        const vault = await getVault(db, id);
        if (!vault?.access) return null;
        const usage = await db.query<{
          files: string;
          bytes: string;
          hidden: string;
          max_files: string;
          max_bytes: string;
        }>("select * from content.vault_usage($1)", [id]);
        const states = await db.query<{ state: FileState; n: string }>(
          `select ${STATE_SQL} state, count(*) n
             from content.document d
             join content.document_version v on v.document_id = d.id
             left join content.ingest_job j on j.version_id = v.id
            where d.vault_id = $1
            group by 1`,
          [id],
        );
        const count = (state: FileState) =>
          Number(states.rows.find((row) => row.state === state)?.n ?? 0);
        const u = usage.rows[0];
        return {
          vault,
          stats: {
            files: Number(u?.files ?? 0),
            bytes: Number(u?.bytes ?? 0),
            hidden: Number(u?.hidden ?? 0),
            queued: count("queued"),
            processing: count("processing"),
            ready: count("ready"),
            failed: count("failed"),
            maxFiles: Number(u?.max_files ?? 0),
            maxBytes: Number(u?.max_bytes ?? 0),
          },
        };
      });
    },

    async update(p, id, patch, client) {
      if (!isId(id)) return { ok: false, reason: "NOT_FOUND" };
      return asApp(pool, p, async (db) => {
        const access = await level(db, id);
        if (!access) return { ok: false, reason: "NOT_FOUND" };
        if (!canManage(access)) return { ok: false, reason: "FORBIDDEN" };
        await db.query(
          `update content.vault
              set name = coalesce($2, name), description = coalesce($3, description),
                  retention_hours = case when $4 then $5::integer else retention_hours end,
                  content_controls = coalesce($6::jsonb, content_controls), updated_at = now()
            where id = $1`,
          [
            id,
            patch.name ?? null,
            patch.description ?? null,
            patch.retentionHours !== undefined,
            patch.retentionHours ?? null,
            patch.contentControls ? JSON.stringify(patch.contentControls) : null,
          ],
        );
        if (patch.retentionHours !== undefined) {
          await audit(db, p, client, "retention.policy_changed", "vault", id, {
            retention_hours: patch.retentionHours,
          });
        }
        await audit(db, p, client, "vault.updated", "vault", id, {
          fields: Object.keys(patch).sort(),
        });
        const vault = await getVault(db, id);
        return vault ? { ok: true, value: vault } : { ok: false, reason: "NOT_FOUND" };
      });
    },

    async remove(p, id, client) {
      if (!isId(id)) return false;
      return asApp(pool, p, async (db) => {
        if (!canManage(await level(db, id))) return false;
        await db.query("select content.trash_vault($1)", [id]);
        await audit(db, p, client, "vault.deleted", "vault", id);
        return true;
      });
    },

    async tree(p, id, query) {
      if (!isId(id)) return null;
      const folderId = isId(query.folderId) ? query.folderId : null;
      if (query.folderId && !folderId) return null;
      const take = Math.min(Math.max(Math.trunc(query.limit ?? PAGE) || PAGE, 1), MAX_PAGE);
      const after = decodeCursor(query.cursor);
      const q = query.q?.trim().replaceAll("\0", "") ?? "";
      return asApp(pool, p, async (db) => {
        if (!(await level(db, id))) return null;
        let path: Folder[] = [];
        if (folderId) {
          const up = await db.query<{
            id: string;
            name: string;
            parent_id: string | null;
            depth: number;
          }>(
            `with recursive up as (
               select f.id, f.name, f.parent_id, 0 depth from content.folder f
                where f.id = $1 and f.vault_id = $2
               union all
               select f.id, f.name, f.parent_id, up.depth + 1 from content.folder f
                 join up on f.id = up.parent_id where up.depth < 100
             ) select * from up order by depth desc`,
            [folderId, id],
          );
          if (up.rows.length === 0) return null;
          path = up.rows.map(toFolder);
        }
        // A name search covers the whole vault, so it lists no folders.
        const folders = q
          ? []
          : (
              await db.query<{ id: string; name: string; parent_id: string | null }>(
                `select id, name, parent_id from content.folder
                  where vault_id = $1 and ${folderId ? "parent_id = $2" : "parent_id is null and $2::uuid is null"}
                  order by lower(name), id`,
                [id, folderId],
              )
            ).rows.map(toFolder);
        const files = await db.query<FileRow>(
          `select d.id, v.id version_id, d.folder_id, d.name, d.mime, d.size, ${STATE_SQL} state,
                  j.reason, v.page_count, d.updated_at, lower(d.name) sort
             from content.document d
             join content.document_version v on v.document_id = d.id
             left join content.ingest_job j on j.version_id = v.id
            where d.vault_id = $1
              and d.parent_id is null
              and ${q ? "strpos(lower(d.name), lower($2)) > 0" : folderId ? "d.folder_id = $2::uuid" : "d.folder_id is null and $2::text is null"}
              and ($3::text is null or coalesce(j.status, 'indexed') = $3)
              and ($4::text is null or (lower(d.name), d.id) > ($4, $5::uuid))
            order by lower(d.name), d.id
            limit $6`,
          [
            id,
            q || folderId,
            query.state ? JOB_STATUS[query.state] : null,
            after?.[0] ?? null,
            after?.[1] ?? null,
            take + 1,
          ],
        );
        const page = files.rows.slice(0, take);
        const last = page.at(-1);
        return {
          path,
          folders,
          files: page.map(toFile),
          nextCursor: files.rows.length > take && last ? encodeCursor(last.sort, last.id) : null,
        };
      });
    },

    async createFolder(p, vaultId, input, client) {
      if (!isId(vaultId) || (input.parentId !== null && !isId(input.parentId))) {
        return { ok: false, reason: "NOT_FOUND" };
      }
      return asApp(pool, p, async (db) => {
        const access = await level(db, vaultId);
        if (!access) return { ok: false, reason: "NOT_FOUND" };
        if (!canEdit(access)) return { ok: false, reason: "FORBIDDEN" };
        const taken = await db.query<{ name: string }>(
          `select name from content.folder
            where vault_id = $1 and parent_id is not distinct from $2`,
          [vaultId, input.parentId],
        );
        const name = freeName(input.name, new Set(taken.rows.map((row) => row.name.toLowerCase())));
        const { rows } = await db.query<{ id: string; name: string; parent_id: string | null }>(
          `insert into content.folder (workspace_id, vault_id, parent_id, name, created_by)
           select $1, $2, $3, $4, $5
            where $3::uuid is null or exists (
              select 1 from content.folder f where f.id = $3 and f.vault_id = $2)
           returning id, name, parent_id`,
          [p.workspaceId, vaultId, input.parentId, name, p.userId],
        );
        const row = rows[0];
        if (!row) return { ok: false, reason: "NOT_FOUND" };
        await audit(db, p, client, "folder.created", "folder", row.id, { vault_id: vaultId });
        return { ok: true, value: toFolder(row) };
      });
    },

    async updateFolder(p, folderId, patch, client) {
      if (!isId(folderId) || (patch.parentId && !isId(patch.parentId))) {
        return { ok: false, reason: "NOT_FOUND" };
      }
      try {
        return await asApp(pool, p, async (db) => {
          const found = await db.query<{ vault_id: string }>(
            "select vault_id from content.folder where id = $1",
            [folderId],
          );
          const vaultId = found.rows[0]?.vault_id;
          if (!vaultId) return { ok: false, reason: "NOT_FOUND" };
          if (!canEdit(await level(db, vaultId))) return { ok: false, reason: "FORBIDDEN" };
          const moving = patch.parentId !== undefined;
          const { rows } = await db.query<{ id: string; name: string; parent_id: string | null }>(
            `update content.folder
                set name = coalesce($2, name),
                    parent_id = case when $3 then $4::uuid else parent_id end
              where id = $1
                and ($4::uuid is null or exists (
                  select 1 from content.folder f where f.id = $4 and f.vault_id = $5))
              returning id, name, parent_id`,
            [folderId, patch.name ?? null, moving, patch.parentId ?? null, vaultId],
          );
          const row = rows[0];
          if (!row) return { ok: false, reason: "NOT_FOUND" };
          await audit(
            db,
            p,
            client,
            moving ? "folder.moved" : "folder.updated",
            "folder",
            folderId,
          );
          return { ok: true, value: toFolder(row) };
        });
      } catch (err) {
        if (codeOf(err) === UNIQUE_VIOLATION || codeOf(err) === CHECK_VIOLATION) {
          return { ok: false, reason: "CONFLICT" };
        }
        throw err;
      }
    },

    async updateFile(p, documentId, patch, client) {
      if (!isId(documentId) || (patch.folderId && !isId(patch.folderId))) {
        return { ok: false, reason: "NOT_FOUND" };
      }
      return asApp(pool, p, async (db) => {
        const found = await db.query<{ vault_id: string | null }>(
          "select vault_id from content.document where id = $1",
          [documentId],
        );
        const vaultId = found.rows[0]?.vault_id;
        if (!vaultId) return { ok: false, reason: "NOT_FOUND" };
        if (!canEdit(await level(db, vaultId))) return { ok: false, reason: "FORBIDDEN" };
        const moving = patch.folderId !== undefined;
        const { rows } = await db.query<{ id: string; name: string; folder_id: string | null }>(
          `update content.document
              set name = coalesce($2, name),
                  folder_id = case when $3 then $4::uuid else folder_id end,
                  updated_at = now()
            where id = $1
              and ($4::uuid is null or exists (
                select 1 from content.folder f where f.id = $4 and f.vault_id = $5))
            returning id, name, folder_id`,
          [documentId, patch.name ?? null, moving, patch.folderId ?? null, vaultId],
        );
        const row = rows[0];
        if (!row) return { ok: false, reason: "NOT_FOUND" };
        await audit(
          db,
          p,
          client,
          moving ? "document.moved" : "document.updated",
          "document",
          documentId,
          {
            vault_id: vaultId,
          },
        );
        return { ok: true, value: { id: row.id, name: row.name, folderId: row.folder_id } };
      });
    },

    async trash(p, vaultId, items, client) {
      if (!isId(vaultId)) return null;
      return asApp(pool, p, async (db) => {
        if (!canEdit(await level(db, vaultId))) return null;
        const { rows } = await db.query<{ n: number }>("select content.trash_items($1, $2, $3) n", [
          vaultId,
          items.documentIds.filter(isId),
          items.folderIds.filter(isId),
        ]);
        await audit(db, p, client, "document.deleted", "vault", vaultId, {
          document_ids: items.documentIds.slice(0, 100),
          folder_ids: items.folderIds.slice(0, 100),
          items: rows[0]?.n ?? 0,
        });
        return rows[0]?.n ?? 0;
      });
    },

    async restore(p, vaultId, items, client) {
      if (!isId(vaultId)) return null;
      return asApp(pool, p, async (db) => {
        if (!canEdit(await level(db, vaultId))) return null;
        const { rows } = await db.query<{ n: number }>(
          "select content.restore_items($1, $2, $3) n",
          [vaultId, items.documentIds.filter(isId), items.folderIds.filter(isId)],
        );
        await audit(db, p, client, "document.restored", "vault", vaultId, {
          document_ids: items.documentIds.slice(0, 100),
          folder_ids: items.folderIds.slice(0, 100),
          items: rows[0]?.n ?? 0,
        });
        return rows[0]?.n ?? 0;
      });
    },

    async bin(p, vaultId) {
      if (!isId(vaultId)) return null;
      return asApp(pool, p, async (db) => {
        if (!canEdit(await level(db, vaultId))) return null;
        const { rows } = await db.query<{
          kind: "folder" | "document";
          id: string;
          name: string;
          deleted_at: Date;
          deleted_reason: "user" | "retention";
        }>("select * from content.vault_bin($1)", [vaultId]);
        return rows.map((row) => ({
          kind: row.kind,
          id: row.id,
          name: row.name,
          deletedAt: row.deleted_at.toISOString(),
          deletedReason: row.deleted_reason,
          purgeAt: new Date(row.deleted_at.getTime() + BIN_DAYS * 86_400_000).toISOString(),
        }));
      });
    },

    async shares(p, vaultId) {
      if (!isId(vaultId)) return null;
      return asApp(pool, p, async (db) => {
        if (!canManage(await level(db, vaultId))) return null;
        const { rows } = await db.query<{
          principal_type: "user" | "group" | "workspace";
          principal_id: string;
          level: VaultGrant["level"];
          name: string;
        }>("select * from content.vault_shares($1)", [vaultId]);
        return {
          grants: rows
            .filter((row) => row.principal_type !== "workspace")
            .map((row) => ({
              principal_type: row.principal_type as "user" | "group",
              principal_id: row.principal_id,
              level: row.level,
              name: row.name,
            })),
          workspaceView: rows.some((row) => row.principal_type === "workspace"),
        };
      });
    },

    async setShares(p, vaultId, shares, client) {
      if (!isId(vaultId)) return null;
      return asApp(pool, p, async (db) => {
        if (!canManage(await level(db, vaultId))) return null;
        const { rows } = await db.query<{ result: { denied_by_wall: string[] } }>(
          "select content.set_vault_shares($1, $2, $3) result",
          [vaultId, JSON.stringify(shares.grants), shares.workspaceView],
        );
        const denied = [...new Set(rows[0]?.result.denied_by_wall ?? [])];
        await audit(db, p, client, "share.changed", "vault", vaultId, {
          grants: shares.grants.length,
          workspace_view: shares.workspaceView,
        });
        for (const userId of denied.slice(0, 100)) {
          await audit(db, p, client, "wall.share_blocked", "vault", vaultId, { user_id: userId });
        }
        return { deniedByWall: denied };
      });
    },

    async preflight(p, vaultId, files) {
      if (!isId(vaultId)) return null;
      return asApp(pool, p, async (db) => {
        if (!canEdit(await level(db, vaultId))) return null;
        const usage = (
          await db.query<{ files: string; bytes: string; max_files: string; max_bytes: string }>(
            "select * from content.vault_usage($1)",
            [vaultId],
          )
        ).rows[0];
        let count = Number(usage?.files ?? 0);
        let bytes = Number(usage?.bytes ?? 0);
        const maxFiles = Number(usage?.max_files ?? 0);
        const maxBytes = Number(usage?.max_bytes ?? 0);
        const result: Preflight = { accepted: [], rejected: [] };
        // In manifest order, so the files that fit are the first ones chosen.
        for (const file of files) {
          const limit = fileTypeLimit(file.name);
          const reason: UploadRejection | null = !limit
            ? "UNSUPPORTED_TYPE"
            : file.size > Math.min(limit.bytes, MAX_FILE_BYTES)
              ? "FILE_TOO_LARGE"
              : count + 1 > maxFiles
                ? "VAULT_FILE_LIMIT"
                : bytes + file.size > maxBytes
                  ? "VAULT_SIZE_LIMIT"
                  : null;
          if (reason) {
            result.rejected.push({ clientRef: file.clientRef, reason });
          } else {
            count += 1;
            bytes += file.size;
            result.accepted.push(file.clientRef);
          }
        }
        return result;
      });
    },

    async upload(p, vaultId, input, client) {
      if (!isId(vaultId) || (input.folderId !== null && !isId(input.folderId))) {
        return { ok: false, reason: "NOT_FOUND" };
      }
      const target = await asApp(pool, p, async (db) => {
        const vault = await getVault(db, vaultId);
        if (!vault?.access) return null;
        if (!canEdit(vault.access)) return { vault, folderId: null };
        const folderId = input.relativePath
          ? await ensurePath(db, p, vaultId, input.folderId, input.relativePath)
          : input.folderId;
        return { vault, folderId };
      });
      if (!target) return { ok: false, reason: "NOT_FOUND" };
      // A file in a matter vault always carries the vault's matter.
      return documents.upload(
        p,
        {
          name: input.name,
          bytes: input.bytes,
          matterId: target.vault.matterId,
          vaultId,
          folderId: target.folderId,
        },
        client,
      );
    },

    async retentionEstimate(p, vaultId, hours) {
      if (!isId(vaultId)) return null;
      return asApp(pool, p, async (db) => {
        if (!canManage(await level(db, vaultId))) return null;
        const { rows } = await db.query<{ n: string; earliest: Date | null }>(
          `select count(*) filter (where created_at < now() - make_interval(hours => $2)) n,
                  min(created_at) + make_interval(hours => $2) earliest
             from content.document where vault_id = $1`,
          [vaultId, hours],
        );
        const row = rows[0];
        return {
          documents: Number(row?.n ?? 0),
          earliestDeletionAt: row?.earliest
            ? new Date(Math.max(row.earliest.getTime(), Date.now())).toISOString()
            : null,
        };
      });
    },

    async findPrincipals(p, query) {
      return asApp(pool, p, async (db) => {
        const { rows } = await db.query<{
          principal_type: "user" | "group";
          principal_id: string;
          label: string;
        }>("select * from content.find_principals($1)", [query.replaceAll("\0", "")]);
        return rows.map((row) => ({
          principalType: row.principal_type,
          principalId: row.principal_id,
          label: row.label,
        }));
      });
    },

    async adminList(p) {
      return asApp(pool, p, async (db) => {
        const allowed = await db.query<{ ok: boolean }>(
          "select core.has_permission('admin.config') ok",
        );
        if (!allowed.rows[0]?.ok) return null;
        const { rows } = await db.query<
          VaultRow & { owner_email: string; files: string; bytes: string; grants: string }
        >(
          `${VAULT_SQL.replace(
            "from content.vault v",
            `, s.owner_email, s.files, s.bytes, s.grants
               from content.vault v join content.admin_vault_stats() s on s.vault_id = v.id`,
          )}
            order by v.deleted_at nulls first, v.updated_at desc limit 1000`,
        );
        return rows.map((row) => ({
          ...toVault(row),
          ownerEmail: row.owner_email,
          files: Number(row.files),
          bytes: Number(row.bytes),
          grants: Number(row.grants),
        }));
      });
    },

    async transfer(p, vaultId, newOwnerId, client) {
      if (!isId(vaultId) || !isId(newOwnerId)) return false;
      try {
        return await asApp(pool, p, async (db) => {
          const { rows } = await db.query<{ ok: boolean }>(
            "select content.transfer_vault($1, $2) ok",
            [vaultId, newOwnerId],
          );
          if (!rows[0]?.ok) return false;
          await audit(db, p, client, "vault.updated", "vault", vaultId, {
            new_owner_id: newOwnerId,
          });
          return true;
        });
      } catch (err) {
        if (codeOf(err) === RLS_REFUSED) return null;
        throw err;
      }
    },

    async restoreVault(p, vaultId, client) {
      if (!isId(vaultId)) return false;
      return asApp(pool, p, async (db) => {
        const { rows } = await db.query<{ ok: boolean }>("select content.restore_vault($1) ok", [
          vaultId,
        ]);
        if (!rows[0]?.ok) return false;
        await audit(db, p, client, "vault.restored", "vault", vaultId);
        return true;
      });
    },

    async purge(p, vaultId, client) {
      if (!isId(vaultId)) return false;
      let hashes: Buffer[];
      try {
        hashes = await asApp(pool, p, async (db) => {
          const { rows } = await db.query<{ sha256: Buffer }>(
            "select sha256 from content.purge_vault($1)",
            [vaultId],
          );
          await audit(db, p, client, "deletion.completed", "vault", vaultId, {
            files: rows.length,
          });
          return rows.map((row) => row.sha256);
        });
      } catch (err) {
        if (codeOf(err) === RLS_REFUSED) return null;
        throw err;
      }
      // After commit: a failed delete leaves an unreachable object, never a dangling row.
      for (const sha of hashes) {
        await store.delete(contentKey(p.workspaceId, sha.toString("hex")));
      }
      return true;
    },
  };
}
