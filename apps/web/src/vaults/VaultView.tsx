import { hasAccess } from "@legallabs/contracts";
import {
  Breadcrumbs,
  Button,
  Checkbox,
  DataTable,
  EmptyState,
  FileStateText,
  FolderTree,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  StatusText,
  type TableColumn,
  type TreeFolder,
  type UploadItem,
  UploadTray,
} from "@legallabs/ui";
import { Folder as FolderIcon, FolderPlus, Upload, Vault as VaultIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "../api.js";
import {
  type Folder,
  failureText,
  type Tree,
  type Vault,
  type VaultFile,
  type VaultStats,
  vaultApi,
} from "./api.js";
import { go } from "./route.js";
import { SettingsPanel } from "./SettingsPanel.js";
import { SharePanel } from "./SharePanel.js";
import { formatBytes, formatDate, messageOf } from "./shared.js";
import { pick, uploadAll } from "./uploads.js";

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

  const editable = hasAccess(vault?.my_access, "edit");
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
            {hasAccess(vault?.my_access, "full") && (
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
