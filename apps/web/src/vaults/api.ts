import type { ContentControls, FileState, VaultAccess, VaultGrant } from "@legallabs/contracts";
import { ApiError } from "../api.js";

export interface Vault {
  id: string;
  name: string;
  description: string;
  matter_id: string | null;
  owner_id: string;
  my_access: VaultAccess | null;
  content_controls: ContentControls;
  retention_hours: number | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface VaultStats {
  files: number;
  bytes: number;
  hidden: number;
  queued: number;
  processing: number;
  ready: number;
  failed: number;
  max_files: number;
  max_bytes: number;
}

export interface Folder {
  id: string;
  name: string;
  parent_id: string | null;
}

export interface VaultFile {
  id: string;
  version_id: string;
  folder_id: string | null;
  name: string;
  mime: string;
  size: number;
  state: FileState;
  failure_reason: string | null;
  page_count: number | null;
  updated_at: string;
}

export interface Tree {
  path: Folder[];
  folders: Folder[];
  files: VaultFile[];
  next_cursor: string | null;
}

export interface BinItem {
  kind: "folder" | "document";
  id: string;
  name: string;
  deleted_at: string;
  deleted_reason: "user" | "retention";
  purge_at: string;
}

export interface Shares {
  grants: (VaultGrant & { name: string })[];
  workspace_view: boolean;
  denied_by_wall?: string[];
}

export interface AdminVault extends Vault {
  owner_email: string;
  files: number;
  bytes: number;
  grants: number;
}

export type Rejection =
  | "FILE_TOO_LARGE"
  | "UNSUPPORTED_TYPE"
  | "VAULT_FILE_LIMIT"
  | "VAULT_SIZE_LIMIT";

const FALLBACK = "Something went wrong. Try again.";

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const json = typeof init.body === "string";
  const res = await fetch(`/api/v1${path}`, {
    ...init,
    credentials: "same-origin",
    headers: json ? { "content-type": "application/json" } : {},
  });
  if (res.status === 202 && res.headers.get("content-length") === "0") return undefined as T;
  const text = await res.text();
  const body = (text ? JSON.parse(text) : null) as Record<string, unknown> | null;
  if (!res.ok) {
    throw new ApiError(
      res.status,
      String(body?.code ?? "UNKNOWN"),
      typeof body?.message === "string" ? body.message : FALLBACK,
    );
  }
  return body as T;
}

const send = <T>(method: string, path: string, body: unknown) =>
  call<T>(path, { method, body: JSON.stringify(body) });
const v = (id: string) => `/vaults/${encodeURIComponent(id)}`;

export const vaultApi = {
  list: async () => (await call<{ vaults: (Vault & { files: number })[] }>("/vaults")).vaults,
  create: async (name: string, description: string) =>
    (await send<{ vault: Vault }>("POST", "/vaults", { name, description })).vault,
  get: (id: string) => call<{ vault: Vault; stats: VaultStats }>(v(id)),
  update: async (
    id: string,
    patch: Partial<Pick<Vault, "name" | "description" | "retention_hours" | "content_controls">>,
  ) => (await send<{ vault: Vault }>("PATCH", v(id), patch)).vault,
  remove: (id: string) => call<void>(v(id), { method: "DELETE" }),
  tree: (id: string, query: { folderId?: string | null; cursor?: string | null; q?: string }) => {
    const params = new URLSearchParams();
    if (query.folderId) params.set("folder_id", query.folderId);
    if (query.cursor) params.set("cursor", query.cursor);
    if (query.q) params.set("q", query.q);
    return call<Tree>(`${v(id)}/tree?${params}`);
  },
  createFolder: async (id: string, name: string, parentId: string | null) =>
    (await send<{ folder: Folder }>("POST", `${v(id)}/folders`, { name, parent_id: parentId }))
      .folder,
  renameFolder: (id: string, folderId: string, name: string) =>
    send<{ folder: Folder }>("PATCH", `${v(id)}/folders/${encodeURIComponent(folderId)}`, { name }),
  updateFile: (id: string, fileId: string, patch: { name?: string; folder_id?: string | null }) =>
    send<{ file: { id: string } }>("PATCH", `${v(id)}/files/${encodeURIComponent(fileId)}`, patch),
  trash: (id: string, documentIds: string[], folderIds: string[]) =>
    send<{ items: number }>("POST", `${v(id)}/trash`, {
      document_ids: documentIds,
      folder_ids: folderIds,
    }),
  restore: (id: string, documentIds: string[], folderIds: string[]) =>
    send<{ items: number }>("POST", `${v(id)}/restore`, {
      document_ids: documentIds,
      folder_ids: folderIds,
    }),
  bin: async (id: string) => (await call<{ items: BinItem[] }>(`${v(id)}/bin`)).items,
  shares: (id: string) => call<Shares>(`${v(id)}/shares`),
  setShares: (id: string, grants: VaultGrant[], workspaceView: boolean) =>
    send<Shares>("PUT", `${v(id)}/shares`, { grants, workspace_view: workspaceView }),
  preflight: (id: string, files: { client_ref: string; name: string; size: number }[]) =>
    send<{
      accepted: { client_ref: string }[];
      rejected: { client_ref: string; reason: Rejection }[];
    }>("POST", `${v(id)}/uploads`, { files }),
  upload: async (id: string, file: File, folderId: string | null, relativePath?: string) => {
    const form = new FormData();
    form.set("file", file);
    if (folderId) form.set("folder_id", folderId);
    if (relativePath) form.set("relative_path", relativePath);
    return (
      await call<{ file: { id: string; state: FileState; failure_reason: string | null } }>(
        `${v(id)}/files`,
        { method: "POST", body: form },
      )
    ).file;
  },
  retry: (fileId: string) =>
    call<unknown>(`/documents/${encodeURIComponent(fileId)}/retry`, { method: "POST" }),
  retentionEstimate: (id: string, hours: number) =>
    call<{ documents: number; earliest_deletion_at: string | null }>(
      `${v(id)}/retention/estimate?hours=${hours}`,
    ),
  adminList: async () => (await call<{ vaults: AdminVault[] }>("/admin/vaults")).vaults,
  transfer: (id: string, newOwnerId: string) =>
    send<{ ok: true }>("POST", `/admin/vaults/${encodeURIComponent(id)}/transfer`, {
      new_owner_id: newOwnerId,
    }),
  restoreVault: (id: string) =>
    call<{ ok: true }>(`/admin/vaults/${encodeURIComponent(id)}/restore`, { method: "POST" }),
  purge: (id: string) =>
    send<{ ok: true }>("POST", `/admin/vaults/${encodeURIComponent(id)}/purge`, {
      confirmation: "DELETE VAULT",
    }),
};

/** Plain words for why a file was refused before upload. */
export const REJECTIONS: Record<Rejection, string> = {
  FILE_TOO_LARGE: "Over the size limit for this type of file.",
  UNSUPPORTED_TYPE: "This type can't be read. Use PDF, Word, Excel, email, TXT or Markdown.",
  VAULT_FILE_LIMIT: "The vault already holds as many files as it can.",
  VAULT_SIZE_LIMIT: "The vault is full.",
};

/** Plain words for why reading a file failed. */
export function failureText(reason: string | null): string {
  switch (reason) {
    case "MALWARE_DETECTED":
    case "QUARANTINED":
      return "A malware scan flagged this file, so it won't be read.";
    case "ENCRYPTED":
    case "ENCRYPTED_NO_PASSWORD":
      return "This file is password protected. Upload an unlocked copy.";
    case "NO_TEXT":
      return "No text could be found in this file.";
    case "UNSUPPORTED_TYPE":
      return "This type can't be read.";
    default:
      return "This file couldn't be read. It may be damaged.";
  }
}
