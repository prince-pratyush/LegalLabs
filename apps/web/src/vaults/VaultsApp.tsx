import type { VaultGrant, VaultLevel } from "@legallabs/contracts";
import {
  AppShell,
  Breadcrumbs,
  Button,
  Checkbox,
  ConfirmDialog,
  DataTable,
  EmptyState,
  Field,
  FileStateText,
  FolderTree,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SidePanel,
  Skeleton,
  StatusText,
  type TableColumn,
  Textarea,
  type TreeFolder,
  type UploadItem,
  UploadTray,
} from "@legallabs/ui";
import { Folder as FolderIcon, FolderPlus, Upload, Vault as VaultIcon } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { ApiError } from "../api.js";
import {
  type AdminVault,
  type BinItem,
  type Folder,
  failureText,
  type Shares,
  type Tree,
  type Vault,
  type VaultFile,
  type VaultStats,
  vaultApi,
} from "./api.js";
import { go, parseRoute, type Route, useHash } from "./route.js";
import { pick, uploadAll } from "./uploads.js";

const FALLBACK = "Something went wrong. Try again.";
const messageOf = (err: unknown) => (err instanceof ApiError ? err.message : FALLBACK);

export const formatBytes = (bytes: number) => {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
};

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

const ACCESS_LABEL = { owner: "Owner", full: "Full access", edit: "Can edit", view: "Can view" };
const canEdit = (v: Vault | null) => ["owner", "full", "edit"].includes(v?.my_access ?? "");
const canManage = (v: Vault | null) => ["owner", "full"].includes(v?.my_access ?? "");

/** Vaults, a vault's files, its bin and the admin list, chosen by the address. */
export function VaultsApp({ onLeave }: { onLeave: () => void }) {
  const route = parseRoute(useHash()) ?? { page: "list" };
  const [vaults, setVaults] = useState<(Vault & { files: number })[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(() => {
    vaultApi.list().then(setVaults, (err) => setError(messageOf(err)));
  }, []);
  useEffect(refresh, [refresh]);

  return (
    <AppShell
      brand="LegalLabs"
      sidebarLabel="Vaults"
      commands={[
        {
          id: "vaults",
          kind: "action",
          group: "Vaults",
          label: "All vaults",
          run: () => go({ page: "list" }),
        },
        {
          id: "admin",
          kind: "action",
          group: "Vaults",
          label: "Admin: every vault",
          run: () => go({ page: "admin" }),
        },
        { id: "threads", kind: "action", group: "Go to", label: "Threads", run: onLeave },
      ]}
      sidebar={
        <div className="grid min-w-0 gap-2">
          <Button variant="quiet" size="sm" className="justify-start" onClick={onLeave}>
            Back to threads
          </Button>
          <h2 className="text-caption font-semibold text-fg-muted uppercase">Vaults</h2>
          {vaults === null ? (
            <div aria-busy="true" className="grid gap-2">
              <Skeleton className="h-5" />
              <Skeleton className="h-5" />
            </div>
          ) : (
            <ul className="grid gap-0.5">
              {vaults.map((v) => (
                <li key={v.id}>
                  <button
                    type="button"
                    aria-current={"vaultId" in route && route.vaultId === v.id ? "page" : undefined}
                    onClick={() => go({ page: "vault", vaultId: v.id, folderId: null })}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-ui hover:tint-hover aria-[current=page]:bg-bg-raised"
                  >
                    <VaultIcon aria-hidden className="size-4 shrink-0 text-fg-muted" />
                    <span className="truncate">{v.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      }
    >
      <main id="main" className="flex min-w-0 flex-1 flex-col overflow-auto p-6">
        {error && (
          <p role="alert" className="mb-4 text-destructive">
            {error}
          </p>
        )}
        <Page route={route} vaults={vaults} onChanged={refresh} />
      </main>
    </AppShell>
  );
}

function Page({
  route,
  vaults,
  onChanged,
}: {
  route: Route;
  vaults: (Vault & { files: number })[] | null;
  onChanged: () => void;
}) {
  switch (route.page) {
    case "list":
      return <VaultList vaults={vaults} onChanged={onChanged} />;
    case "admin":
      return <AdminVaults onChanged={onChanged} />;
    case "bin":
      return <RecycleBin vaultId={route.vaultId} />;
    case "vault":
      return (
        <VaultView
          key={route.vaultId}
          vaultId={route.vaultId}
          folderId={route.folderId}
          onChanged={onChanged}
        />
      );
  }
}

export function VaultList({
  vaults,
  onChanged,
}: {
  vaults: (Vault & { files: number })[] | null;
  onChanged: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const vault = await vaultApi.create(name.trim(), description.trim());
      onChanged();
      go({ page: "vault", vaultId: vault.id, folderId: null });
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  const columns: TableColumn<Vault & { files: number }>[] = [
    { id: "name", header: "Name", cell: (v) => v.name, sortValue: (v) => v.name.toLowerCase() },
    {
      id: "files",
      header: "Files",
      cell: (v) => v.files.toLocaleString(),
      sortValue: (v) => v.files,
      align: "end",
      width: 100,
    },
    {
      id: "access",
      header: "Access",
      cell: (v) => (v.my_access ? ACCESS_LABEL[v.my_access] : "—"),
      width: 140,
    },
    {
      id: "updated",
      header: "Updated",
      cell: (v) => formatDate(v.updated_at),
      sortValue: (v) => v.updated_at,
      width: 140,
    },
  ];

  return (
    <div className="grid max-w-5xl gap-6">
      <header className="flex items-center justify-between gap-4">
        <h1 className="text-title font-semibold">Vaults</h1>
        <Button onClick={() => setCreating(!creating)}>Create vault</Button>
      </header>
      {creating && (
        <form onSubmit={create} className="grid max-w-lg gap-3 rounded-md border border-border p-4">
          <Field label="Name">
            {(props) => (
              <Input
                {...props}
                value={name}
                maxLength={200}
                required
                onChange={(e) => setName(e.target.value)}
              />
            )}
          </Field>
          <Field label="Description" hint="Optional. Who it's for and what goes in it.">
            {(props) => (
              <Textarea
                {...props}
                value={description}
                maxLength={2000}
                onChange={(e) => setDescription(e.target.value)}
              />
            )}
          </Field>
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <Button type="submit" disabled={busy || name.trim() === ""}>
              {busy ? "Creating…" : "Create"}
            </Button>
            <Button variant="secondary" onClick={() => setCreating(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      {vaults !== null && vaults.length === 0 && !creating ? (
        <EmptyState
          icon={VaultIcon}
          title="No vaults yet"
          description="A vault holds the files for one deal, case or project, shared with the people working on it."
          action={{ label: "Create vault", onClick: () => setCreating(true) }}
        />
      ) : (
        <DataTable
          label="Vaults"
          columns={columns}
          rows={vaults ?? []}
          loading={vaults === null}
          getRowId={(v) => v.id}
          onActivate={(v) => go({ page: "vault", vaultId: v.id, folderId: null })}
          empty="No vaults"
        />
      )}
    </div>
  );
}

type Row = { kind: "folder"; folder: Folder } | { kind: "file"; file: VaultFile };
const rowId = (row: Row) => (row.kind === "folder" ? `f:${row.folder.id}` : row.file.id);

/** The words someone sees for a vault's progress, e.g. "412 of 420 ready · 8 failed". */
export function statsLine(stats: VaultStats) {
  const parts = [`${stats.ready.toLocaleString()} of ${stats.files.toLocaleString()} ready`];
  const reading = stats.queued + stats.processing;
  if (reading) parts.push(`${reading.toLocaleString()} reading`);
  if (stats.failed) parts.push(`${stats.failed.toLocaleString()} failed`);
  return parts.join(" · ");
}

export function VaultView({
  vaultId,
  folderId,
  onChanged,
}: {
  vaultId: string;
  folderId: string | null;
  onChanged: () => void;
}) {
  const [vault, setVault] = useState<Vault | null>(null);
  const [stats, setStats] = useState<VaultStats | null>(null);
  const [tree, setTree] = useState<Tree | null>(null);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [loadingFolders, setLoadingFolders] = useState<(string | null)[]>([null]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [uploads, setUploads] = useState<(UploadItem & { fileId?: string })[]>([]);
  const [panel, setPanel] = useState<"share" | "settings" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const filesInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  const loadVault = useCallback(() => {
    vaultApi.get(vaultId).then(
      (found) => {
        setVault(found.vault);
        setStats(found.stats);
      },
      (err) =>
        err instanceof ApiError && err.status === 404 ? setMissing(true) : setError(messageOf(err)),
    );
  }, [vaultId]);

  const merge = useCallback((more: Folder[]) => {
    setFolders((current) => {
      const byId = new Map(current.map((f) => [f.id, f]));
      for (const f of more) byId.set(f.id, f);
      return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
    });
  }, []);

  const loadTree = useCallback(
    (cursor?: string) => {
      vaultApi.tree(vaultId, { folderId, cursor: cursor ?? null, q: query.trim() }).then(
        (found) => {
          setTree((current) =>
            cursor && current ? { ...found, files: [...current.files, ...found.files] } : found,
          );
          if (!query.trim()) merge(found.folders);
          merge(found.path);
          setLoadingFolders((l) => l.filter((id) => id !== folderId));
        },
        (err) => setError(messageOf(err)),
      );
    },
    [vaultId, folderId, query, merge],
  );

  useEffect(loadVault, [loadVault]);
  useEffect(() => {
    setTree(null);
    setSelected(new Set());
    loadTree();
  }, [loadTree]);
  // Opening a folder in the address also opens the tree down to it.
  useEffect(() => {
    if (tree) setExpanded((e) => new Set([...e, ...tree.path.map((f) => f.id)]));
  }, [tree]);

  // Files are read in the background, so progress is refreshed until nothing is waiting.
  const reading = uploads.some(
    (u) => u.fileId && (u.state === "queued" || u.state === "processing"),
  );
  useEffect(() => {
    if (!reading) return;
    const timer = setInterval(async () => {
      const waiting = uploads.filter(
        (u) => u.fileId && (u.state === "queued" || u.state === "processing"),
      );
      const states = await Promise.all(
        waiting.slice(0, 20).map(async (u) => {
          const res = await fetch(`/api/v1/documents/${u.fileId}`, { credentials: "same-origin" });
          const body = res.ok
            ? ((await res.json()) as {
                document: { status: string; failure_reason: string | null };
              })
            : null;
          return { id: u.id, document: body?.document };
        }),
      );
      setUploads((current) =>
        current.map((u) => {
          const found = states.find((s) => s.id === u.id)?.document;
          if (!found) return u;
          const state =
            found.status === "indexed"
              ? "ready"
              : found.status === "parsing"
                ? "processing"
                : (found.status as UploadItem["state"]);
          return {
            ...u,
            state,
            ...(state === "failed" ? { message: failureText(found.failure_reason) } : {}),
          };
        }),
      );
      loadVault();
    }, 2000);
    return () => clearInterval(timer);
  }, [reading, uploads, loadVault]);

  const toggleFolder = (id: string) => {
    const next = new Set(expanded);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
      if (!folders.some((f) => f.parent_id === id)) {
        setLoadingFolders((l) => [...l, id]);
        vaultApi.tree(vaultId, { folderId: id }).then(
          (found) => {
            merge(found.folders);
            setLoadingFolders((l) => l.filter((x) => x !== id));
          },
          () => setLoadingFolders((l) => l.filter((x) => x !== id)),
        );
      }
    }
    setExpanded(next);
  };

  const startUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const picked = pick(files);
    const base = uploads.length;
    setUploads((current) => [
      ...current,
      ...picked.map((p, i) => ({
        id: String(base + i),
        name: p.relativePath ? `${p.relativePath}/${p.file.name}` : p.file.name,
        state: "waiting" as const,
      })),
    ]);
    try {
      await uploadAll(vaultId, folderId, picked, (ref, change) =>
        setUploads((current) =>
          current.map((u) => (u.id === String(base + Number(ref)) ? { ...u, ...change } : u)),
        ),
      );
    } catch (err) {
      setError(messageOf(err));
    }
    loadTree();
    loadVault();
    onChanged();
  };

  const newFolder = async () => {
    const name = window.prompt("Folder name");
    if (!name?.trim()) return;
    try {
      await vaultApi.createFolder(vaultId, name.trim(), folderId);
      loadTree();
    } catch (err) {
      setError(messageOf(err));
    }
  };

  const rows: Row[] = useMemo(
    () => [
      ...(tree?.folders ?? []).map((folder) => ({ kind: "folder" as const, folder })),
      ...(tree?.files ?? []).map((file) => ({ kind: "file" as const, file })),
    ],
    [tree],
  );

  const removeSelected = async () => {
    const ids = [...selected];
    try {
      await vaultApi.trash(
        vaultId,
        ids.filter((id) => !id.startsWith("f:")),
        ids.filter((id) => id.startsWith("f:")).map((id) => id.slice(2)),
      );
      setSelected(new Set());
      setFolders((current) => current.filter((f) => !selected.has(`f:${f.id}`)));
      loadTree();
      loadVault();
    } catch (err) {
      setError(messageOf(err));
    }
  };

  const renameSelected = async () => {
    const id = [...selected][0];
    const row = rows.find((r) => rowId(r) === id);
    if (!row) return;
    const current = row.kind === "folder" ? row.folder.name : row.file.name;
    const name = window.prompt("New name", current)?.trim();
    if (!name || name === current) return;
    try {
      if (row.kind === "folder") await vaultApi.renameFolder(vaultId, row.folder.id, name);
      else await vaultApi.updateFile(vaultId, row.file.id, { name });
      setFolders((list) =>
        list.map((f) => (row.kind === "folder" && f.id === row.folder.id ? { ...f, name } : f)),
      );
      loadTree();
    } catch (err) {
      setError(messageOf(err));
    }
  };

  const moveSelected = async (target: string) => {
    const destination = target === "top" ? null : target;
    try {
      for (const id of selected) {
        if (id.startsWith("f:")) continue;
        await vaultApi.updateFile(vaultId, id, { folder_id: destination });
      }
      setSelected(new Set());
      loadTree();
    } catch (err) {
      setError(messageOf(err));
    }
  };

  if (missing) {
    return (
      <EmptyState
        icon={VaultIcon}
        title="This vault isn't available"
        description="It may have been deleted, or it hasn't been shared with you."
        action={{ label: "All vaults", onClick: () => go({ page: "list" }) }}
      />
    );
  }

  const editable = canEdit(vault);
  const toggleRow = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const columns: TableColumn<Row>[] = [
    ...(editable
      ? [
          {
            id: "select",
            header: "Select",
            width: 48,
            cell: (row: Row) => (
              <Checkbox
                aria-label={`Select ${row.kind === "folder" ? row.folder.name : row.file.name}`}
                checked={selected.has(rowId(row))}
                onCheckedChange={() => toggleRow(rowId(row))}
              />
            ),
          },
        ]
      : []),
    {
      id: "name",
      header: "Name",
      cell: (row) =>
        row.kind === "folder" ? (
          <button
            type="button"
            className="flex items-center gap-2 font-medium hover:underline"
            onClick={() => go({ page: "vault", vaultId, folderId: row.folder.id })}
          >
            <FolderIcon aria-hidden className="size-4 text-fg-muted" />
            {row.folder.name}
          </button>
        ) : (
          <span className="truncate" title={row.file.name}>
            {row.file.name}
          </span>
        ),
    },
    {
      id: "state",
      header: "Status",
      width: 140,
      cell: (row) => (row.kind === "file" ? <FileStateText state={row.file.state} /> : null),
    },
    {
      id: "pages",
      header: "Pages",
      width: 80,
      align: "end",
      cell: (row) => (row.kind === "file" ? (row.file.page_count ?? "—") : null),
    },
    {
      id: "size",
      header: "Size",
      width: 100,
      align: "end",
      cell: (row) => (row.kind === "file" ? formatBytes(row.file.size) : null),
    },
    {
      id: "modified",
      header: "Modified",
      width: 130,
      cell: (row) => (row.kind === "file" ? formatDate(row.file.updated_at) : null),
    },
  ];

  const crumbs = [
    { id: null, label: vault?.name ?? "Vault" },
    ...(tree?.path ?? []).map((f) => ({ id: f.id, label: f.name })),
  ];

  return (
    <div className="flex min-h-0 flex-1 gap-6">
      <aside className="hidden w-60 shrink-0 overflow-auto lg:block">
        <FolderTree
          label="Folders"
          rootLabel={vault?.name ?? "Vault"}
          folders={folders.map(
            (f): TreeFolder => ({ id: f.id, name: f.name, parentId: f.parent_id }),
          )}
          expanded={expanded}
          loading={loadingFolders}
          selectedId={folderId}
          onSelect={(id) => go({ page: "vault", vaultId, folderId: id })}
          onToggle={toggleFolder}
        />
      </aside>
      <section className="flex min-w-0 flex-1 flex-col gap-4">
        <header className="grid gap-2">
          <div className="flex flex-wrap items-center gap-2">
            {vault ? (
              <h1 className="mr-auto text-title font-semibold">{vault.name}</h1>
            ) : (
              <Skeleton className="mr-auto h-7 w-64" />
            )}
            {editable && (
              <>
                <Button onClick={() => filesInput.current?.click()}>
                  <Upload aria-hidden />
                  Upload files
                </Button>
                <Button variant="secondary" onClick={() => folderInput.current?.click()}>
                  Upload folder
                </Button>
                <Button variant="secondary" onClick={newFolder}>
                  <FolderPlus aria-hidden />
                  New folder
                </Button>
                <Button variant="secondary" onClick={() => go({ page: "bin", vaultId })}>
                  Recycle bin
                </Button>
              </>
            )}
            {canManage(vault) && (
              <>
                <Button variant="secondary" onClick={() => setPanel("share")}>
                  Share
                </Button>
                <Button variant="secondary" onClick={() => setPanel("settings")}>
                  Settings
                </Button>
              </>
            )}
          </div>
          <p aria-live="polite" className="text-ui text-fg-muted">
            {stats ? statsLine(stats) : <Skeleton className="h-4 w-48" />}
          </p>
          {stats && stats.hidden > 0 && (
            <StatusText tone="locked">
              {stats.hidden.toLocaleString()} {stats.hidden === 1 ? "file is" : "files are"} hidden
              by matter restrictions
            </StatusText>
          )}
          <input
            ref={filesInput}
            type="file"
            multiple
            hidden
            aria-label="Choose files"
            onChange={(e) => {
              void startUpload(e.target.files);
              e.target.value = "";
            }}
          />
          <input
            ref={folderInput}
            type="file"
            multiple
            hidden
            aria-label="Choose a folder"
            {...{ webkitdirectory: "" }}
            onChange={(e) => {
              void startUpload(e.target.files);
              e.target.value = "";
            }}
          />
        </header>
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Breadcrumbs
            items={crumbs}
            onSelect={(id) => go({ page: "vault", vaultId, folderId: id })}
            className="mr-auto"
          />
          <Input
            type="search"
            aria-label="Find files by name in this vault"
            placeholder="Find files by name"
            className="w-64"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {selected.size > 0 && (
          <div
            role="toolbar"
            aria-label="Selected items"
            className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-bg-raised px-3 py-2"
          >
            <span className="mr-auto text-ui">{selected.size} selected</span>
            {selected.size === 1 && (
              <Button variant="secondary" size="sm" onClick={renameSelected}>
                Rename
              </Button>
            )}
            <Select onValueChange={moveSelected}>
              <SelectTrigger aria-label="Move files to" className="w-48">
                <SelectValue placeholder="Move files to…" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="top">{vault?.name ?? "Top of the vault"}</SelectItem>
                {folders.map((f) => (
                  <SelectItem key={f.id} value={f.id}>
                    {f.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="destructive" size="sm" onClick={removeSelected}>
              Move to bin
            </Button>
          </div>
        )}
        {tree && rows.length === 0 ? (
          <EmptyState
            icon={FolderIcon}
            title={query.trim() ? `No files named like “${query.trim()}”` : "Nothing here yet"}
            description={
              editable
                ? "Drop files here, or upload a whole folder to keep its structure."
                : "Files added to this vault will show here."
            }
            action={
              editable
                ? { label: "Upload files", onClick: () => filesInput.current?.click() }
                : { label: "All vaults", onClick: () => go({ page: "list" }) }
            }
          />
        ) : (
          <DataTable
            label={`Files in ${crumbs.at(-1)?.label ?? "vault"}`}
            columns={columns}
            rows={rows}
            loading={tree === null}
            getRowId={rowId}
            onActivate={(row) =>
              row.kind === "folder" && go({ page: "vault", vaultId, folderId: row.folder.id })
            }
            empty="No files"
            height={560}
          />
        )}
        {tree?.next_cursor && (
          <Button
            variant="secondary"
            className="self-start"
            onClick={() => loadTree(tree.next_cursor ?? undefined)}
          >
            Show more files
          </Button>
        )}
      </section>
      {panel && vault && (
        <div className="fixed inset-y-0 right-0 z-40">
          {panel === "share" ? (
            <SharePanel vault={vault} onClose={() => setPanel(null)} />
          ) : (
            <SettingsPanel
              vault={vault}
              onSaved={(next) => {
                setVault(next);
                onChanged();
              }}
              onDeleted={() => {
                onChanged();
                go({ page: "list" });
              }}
              onClose={() => setPanel(null)}
            />
          )}
        </div>
      )}
      {uploads.length > 0 && (
        <UploadTray
          className="fixed right-4 bottom-4 z-30"
          items={uploads}
          onRetry={async (id) => {
            const item = uploads.find((u) => u.id === id);
            if (!item?.fileId) return;
            try {
              await vaultApi.retry(item.fileId);
              setUploads((current) =>
                current.map((u) => (u.id === id ? { ...u, state: "queued" } : u)),
              );
            } catch (err) {
              setError(messageOf(err));
            }
          }}
          onClose={() => setUploads([])}
        />
      )}
    </div>
  );
}

const LEVELS: { value: VaultLevel; label: string }[] = [
  { value: "view", label: "Can view" },
  { value: "edit", label: "Can edit" },
  { value: "full", label: "Full access" },
];

export function SharePanel({ vault, onClose }: { vault: Vault; onClose: () => void }) {
  const [shares, setShares] = useState<Shares | null>(null);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<
    { principal_type: "user" | "group"; principal_id: string; label: string }[]
  >([]);
  const [denied, setDenied] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [width, setWidth] = useState(420);

  useEffect(() => {
    vaultApi.shares(vault.id).then(setShares, (err) => setError(messageOf(err)));
  }, [vault.id]);

  useEffect(() => {
    if (query.trim().length < 2) {
      setFound([]);
      return;
    }
    const timer = setTimeout(async () => {
      const res = await fetch(`/api/v1/vaults/principals?q=${encodeURIComponent(query.trim())}`, {
        credentials: "same-origin",
      });
      if (res.ok) setFound(((await res.json()) as { principals: typeof found }).principals);
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  const save = async (grants: (VaultGrant & { name: string })[], workspaceView: boolean) => {
    setError(null);
    try {
      const next = await vaultApi.setShares(
        vault.id,
        grants.map(({ principal_type, principal_id, level }) => ({
          principal_type,
          principal_id,
          level,
        })),
        workspaceView,
      );
      setShares(next);
      const names = new Map([...grants].map((g) => [g.principal_id, g.name]));
      setDenied((next.denied_by_wall ?? []).map((id) => names.get(id) ?? "A group member"));
    } catch (err) {
      setError(messageOf(err));
    }
  };

  return (
    <SidePanel
      title={`Share ${vault.name}`}
      onClose={onClose}
      width={width}
      onWidthChange={setWidth}
    >
      <div className="grid gap-4 overflow-auto p-4">
        {shares === null ? (
          <div aria-busy="true" className="grid gap-2">
            <Skeleton className="h-8" />
            <Skeleton className="h-8" />
          </div>
        ) : (
          <>
            <Field label="Add people or groups" hint="Search by email or group name.">
              {(props) => (
                <Input {...props} value={query} onChange={(e) => setQuery(e.target.value)} />
              )}
            </Field>
            {found.length > 0 && (
              <ul aria-label="Matches" className="grid gap-1">
                {found
                  .filter((f) => !shares.grants.some((g) => g.principal_id === f.principal_id))
                  .map((f) => (
                    <li key={f.principal_id} className="flex items-center gap-2">
                      <span className="flex-1 truncate text-ui">
                        {f.label}{" "}
                        {f.principal_type === "group" && (
                          <span className="text-fg-muted">(group)</span>
                        )}
                      </span>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          setQuery("");
                          void save(
                            [
                              ...shares.grants,
                              {
                                principal_type: f.principal_type,
                                principal_id: f.principal_id,
                                level: "view",
                                name: f.label,
                              },
                            ],
                            shares.workspace_view,
                          );
                        }}
                      >
                        Add
                      </Button>
                    </li>
                  ))}
              </ul>
            )}
            {denied.length > 0 && (
              <StatusText tone="locked">
                {denied.join(", ")} {denied.length === 1 ? "is" : "are"} walled off from this
                vault's matter and won't see it.
              </StatusText>
            )}
            <ul aria-label="People with access" className="grid gap-2">
              {shares.grants.map((g) => (
                <li key={g.principal_id} className="flex items-center gap-2">
                  <span className="flex-1 truncate text-ui">{g.name}</span>
                  <Select
                    value={g.level}
                    onValueChange={(level) =>
                      save(
                        shares.grants.map((x) =>
                          x.principal_id === g.principal_id
                            ? { ...x, level: level as VaultLevel }
                            : x,
                        ),
                        shares.workspace_view,
                      )
                    }
                  >
                    <SelectTrigger aria-label={`Access for ${g.name}`} className="w-36">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {LEVELS.map((l) => (
                        <SelectItem key={l.value} value={l.value}>
                          {l.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    size="sm"
                    variant="quiet"
                    onClick={() =>
                      save(
                        shares.grants.filter((x) => x.principal_id !== g.principal_id),
                        shares.workspace_view,
                      )
                    }
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
            <CheckRow
              checked={shares.workspace_view}
              onChange={(checked) => save(shares.grants, checked)}
              label="Everyone in the workspace can view"
            />
            <ContentControlsForm vault={vault} />
          </>
        )}
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
      </div>
    </SidePanel>
  );
}

function CheckRow({
  checked,
  onChange,
  label,
  detail,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  detail?: string;
}) {
  const id = useId();
  return (
    <div className="flex items-start gap-2">
      <Checkbox id={id} checked={checked} onCheckedChange={(value) => onChange(value === true)} />
      <Label htmlFor={id} className="font-normal">
        {label}
        {detail && <span className="block text-caption text-fg-muted">{detail}</span>}
      </Label>
    </div>
  );
}

const CONTROLS = [
  {
    key: "allow_download",
    label: "Allow download",
    detail: "People who can view may download originals.",
  },
  {
    key: "allow_duplicate",
    label: "Allow duplication",
    detail: "People who can view may copy files or extracted text elsewhere.",
  },
  {
    key: "show_review_prompts",
    label: "Show recent questions",
    detail: "People who can view see the vault's recent questions.",
  },
] as const;

function ContentControlsForm({ vault }: { vault: Vault }) {
  const [controls, setControls] = useState(vault.content_controls);
  const [error, setError] = useState<string | null>(null);
  return (
    <fieldset className="grid gap-2 border-t border-border pt-4">
      <legend className="text-ui font-medium">For people who can view</legend>
      {CONTROLS.map((c) => (
        <CheckRow
          key={c.key}
          checked={controls[c.key]}
          label={c.label}
          detail={c.detail}
          onChange={async (checked) => {
            const next = { ...controls, [c.key]: checked };
            setControls(next);
            try {
              await vaultApi.update(vault.id, { content_controls: next });
            } catch (err) {
              setControls(controls);
              setError(messageOf(err));
            }
          }}
        />
      ))}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </fieldset>
  );
}

export function SettingsPanel({
  vault,
  onSaved,
  onDeleted,
  onClose,
}: {
  vault: Vault;
  onSaved: (vault: Vault) => void;
  onDeleted: () => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(vault.name);
  const [description, setDescription] = useState(vault.description);
  const [keep, setKeep] = useState(vault.retention_hours !== null);
  const [hours, setHours] = useState(String(vault.retention_hours ?? 720));
  const [estimate, setEstimate] = useState<{ documents: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [width, setWidth] = useState(420);
  const parsedHours = Number(hours);
  const validHours = Number.isInteger(parsedHours) && parsedHours >= 3;

  useEffect(() => {
    if (!keep || !validHours) {
      setEstimate(null);
      return;
    }
    const timer = setTimeout(() => {
      vaultApi.retentionEstimate(vault.id, parsedHours).then(setEstimate, () => setEstimate(null));
    }, 300);
    return () => clearTimeout(timer);
  }, [keep, validHours, parsedHours, vault.id]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSaved(
        await vaultApi.update(vault.id, {
          name: name.trim(),
          description: description.trim(),
          retention_hours: keep ? parsedHours : null,
        }),
      );
      onClose();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SidePanel title="Vault settings" onClose={onClose} width={width} onWidthChange={setWidth}>
      <form onSubmit={save} className="grid gap-4 overflow-auto p-4">
        <Field label="Name">
          {(props) => (
            <Input
              {...props}
              value={name}
              maxLength={200}
              required
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </Field>
        <Field label="Description">
          {(props) => (
            <Textarea
              {...props}
              value={description}
              maxLength={2000}
              onChange={(e) => setDescription(e.target.value)}
            />
          )}
        </Field>
        <fieldset className="grid gap-2">
          <legend className="text-ui font-medium">Retention</legend>
          <CheckRow
            checked={keep}
            onChange={setKeep}
            label="Move files to the recycle bin after a set time"
          />
          {keep && (
            <Field
              label="Hours to keep each file"
              hint={
                estimate
                  ? `${estimate.documents.toLocaleString()} ${estimate.documents === 1 ? "file is" : "files are"} older than this and would go to the bin within a day.`
                  : "At least 3. 720 hours is 30 days."
              }
              {...(validHours ? {} : { error: "Enter a whole number of hours, at least 3." })}
            >
              {(props) => (
                <Input
                  {...props}
                  inputMode="numeric"
                  value={hours}
                  className="w-32"
                  onChange={(e) => setHours(e.target.value)}
                />
              )}
            </Field>
          )}
        </fieldset>
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
        <div className="flex gap-2">
          <Button type="submit" disabled={busy || name.trim() === "" || (keep && !validHours)}>
            {busy ? "Saving…" : "Save"}
          </Button>
          <ConfirmDialog
            trigger={<Button variant="destructive">Delete vault</Button>}
            title={`Delete ${vault.name}?`}
            description="It moves to the recycle bin with every file in it. You or an admin can restore it within 30 days."
            confirmLabel="Delete vault"
            destructive
            onConfirm={async () => {
              try {
                await vaultApi.remove(vault.id);
                onDeleted();
              } catch (err) {
                setError(messageOf(err));
              }
            }}
          />
        </div>
      </form>
    </SidePanel>
  );
}

export function RecycleBin({ vaultId }: { vaultId: string }) {
  const [items, setItems] = useState<BinItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    vaultApi.bin(vaultId).then(setItems, (err) => setError(messageOf(err)));
  }, [vaultId]);
  useEffect(load, [load]);

  const restore = async (item: BinItem) => {
    try {
      await vaultApi.restore(
        vaultId,
        item.kind === "document" ? [item.id] : [],
        item.kind === "folder" ? [item.id] : [],
      );
      load();
    } catch (err) {
      setError(messageOf(err));
    }
  };

  const daysLeft = (iso: string) =>
    Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000));
  const columns: TableColumn<BinItem>[] = [
    { id: "name", header: "Name", cell: (i) => (i.kind === "folder" ? `${i.name}/` : i.name) },
    {
      id: "why",
      header: "Removed by",
      width: 160,
      cell: (i) => (i.deleted_reason === "retention" ? "Retention policy" : "A person"),
    },
    { id: "when", header: "Deleted", width: 130, cell: (i) => formatDate(i.deleted_at) },
    {
      id: "left",
      header: "Days left",
      width: 100,
      align: "end",
      cell: (i) => daysLeft(i.purge_at),
    },
    {
      id: "restore",
      header: "Restore",
      width: 110,
      cell: (i) => (
        <Button
          size="sm"
          variant="secondary"
          aria-label={`Restore ${i.name}`}
          onClick={() => restore(i)}
        >
          Restore
        </Button>
      ),
    },
  ];

  return (
    <div className="grid max-w-5xl gap-4">
      <Breadcrumbs
        items={[
          { id: vaultId, label: "Vault" },
          { id: null, label: "Recycle bin" },
        ]}
        onSelect={() => go({ page: "vault", vaultId, folderId: null })}
      />
      <h1 className="text-title font-semibold">Recycle bin</h1>
      <p className="text-ui text-fg-muted">
        Items stay here for 30 days, then are deleted for good.
      </p>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <DataTable
        label="Deleted items"
        columns={columns}
        rows={items ?? []}
        loading={items === null}
        getRowId={(i) => i.id}
        empty="The bin is empty."
      />
    </div>
  );
}

export function AdminVaults({ onChanged }: { onChanged: () => void }) {
  const [vaults, setVaults] = useState<AdminVault[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    vaultApi.adminList().then(setVaults, (err) => setError(messageOf(err)));
  }, []);
  useEffect(load, [load]);

  const act = async (work: () => Promise<unknown>) => {
    try {
      await work();
      load();
      onChanged();
    } catch (err) {
      setError(messageOf(err));
    }
  };

  const columns: TableColumn<AdminVault>[] = [
    { id: "name", header: "Name", cell: (v) => v.name, sortValue: (v) => v.name.toLowerCase() },
    {
      id: "owner",
      header: "Owner",
      width: 220,
      cell: (v) => v.owner_email,
      sortValue: (v) => v.owner_email,
    },
    {
      id: "files",
      header: "Files",
      width: 90,
      align: "end",
      cell: (v) => v.files.toLocaleString(),
      sortValue: (v) => v.files,
    },
    {
      id: "size",
      header: "Size",
      width: 100,
      align: "end",
      cell: (v) => formatBytes(v.bytes),
      sortValue: (v) => v.bytes,
    },
    { id: "shared", header: "Shared with", width: 110, align: "end", cell: (v) => v.grants },
    {
      id: "retention",
      header: "Retention",
      width: 110,
      cell: (v) => (v.retention_hours ? `${v.retention_hours} h` : "None"),
    },
    {
      id: "state",
      header: "State",
      width: 260,
      cell: (v) =>
        v.deleted_at ? (
          <span className="flex items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => act(() => vaultApi.restoreVault(v.id))}
            >
              Restore
            </Button>
            <ConfirmDialog
              trigger={
                <Button size="sm" variant="destructive">
                  Purge now
                </Button>
              }
              title={`Purge ${v.name}?`}
              description={`Its ${v.files.toLocaleString()} files are deleted for good. This can't be undone.`}
              confirmLabel="Purge vault"
              destructive
              onConfirm={() => act(() => vaultApi.purge(v.id))}
            />
          </span>
        ) : (
          "Active"
        ),
    },
  ];

  return (
    <div className="grid gap-4">
      <h1 className="text-title font-semibold">Every vault</h1>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <DataTable
        label="Every vault in the workspace"
        columns={columns}
        rows={vaults ?? []}
        loading={vaults === null}
        getRowId={(v) => v.id}
        empty="No vaults yet."
      />
    </div>
  );
}
