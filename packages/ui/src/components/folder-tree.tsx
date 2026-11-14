import { ChevronRight, Folder, FolderOpen, Vault } from "lucide-react";
import { cn } from "../cn.js";
import { Skeleton } from "./status.js";

export interface TreeFolder {
  id: string;
  name: string;
  parentId: string | null;
}

/**
 * A vault's folders as nested lists. Children appear once loaded, so a 10,000-file vault
 * never draws more than the folders someone has opened.
 */
export function FolderTree({
  label,
  rootLabel,
  folders,
  expanded,
  loading = [],
  selectedId,
  onSelect,
  onToggle,
  className,
}: {
  label: string;
  rootLabel: string;
  folders: readonly TreeFolder[];
  expanded: ReadonlySet<string>;
  /** Folders whose children are being fetched; null is the vault's top level. */
  loading?: readonly (string | null)[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onToggle: (id: string) => void;
  className?: string;
}) {
  const children = new Map<string | null, TreeFolder[]>();
  for (const folder of folders) {
    const list = children.get(folder.parentId) ?? [];
    list.push(folder);
    children.set(folder.parentId, list);
  }

  const rowClass = (selected: boolean) =>
    cn(
      "flex h-row min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-ui hover:tint-hover",
      selected && "bg-bg-raised font-medium text-fg",
      !selected && "text-fg-muted",
    );

  const branch = (parentId: string | null, depth: number) => {
    if (loading.includes(parentId)) {
      return (
        <ul aria-busy="true" aria-label="Loading folders" style={{ paddingLeft: depth * 16 }}>
          {[0, 1, 2].map((i) => (
            <li key={i} className="py-1 pl-8">
              <Skeleton className="h-4 w-32" />
            </li>
          ))}
        </ul>
      );
    }
    const list = children.get(parentId) ?? [];
    if (list.length === 0) return null;
    return (
      <ul>
        {list.map((folder) => {
          const open = expanded.has(folder.id);
          const selected = folder.id === selectedId;
          const Icon = open ? FolderOpen : Folder;
          return (
            <li key={folder.id}>
              <div className="flex items-center" style={{ paddingLeft: depth * 16 }}>
                <button
                  type="button"
                  aria-expanded={open}
                  aria-label={`${open ? "Collapse" : "Expand"} ${folder.name}`}
                  onClick={() => onToggle(folder.id)}
                  className="grid size-6 shrink-0 place-items-center rounded-sm text-fg-muted hover:tint-hover"
                >
                  <ChevronRight
                    aria-hidden
                    className={cn("size-4 transition-transform", open && "rotate-90")}
                  />
                </button>
                <button
                  type="button"
                  aria-current={selected ? "page" : undefined}
                  onClick={() => onSelect(folder.id)}
                  className={rowClass(selected)}
                >
                  <Icon aria-hidden className="size-4 shrink-0" />
                  <span className="truncate">{folder.name}</span>
                </button>
              </div>
              {open && branch(folder.id, depth + 1)}
            </li>
          );
        })}
      </ul>
    );
  };

  return (
    <nav aria-label={label} className={cn("grid gap-0.5", className)}>
      <button
        type="button"
        aria-current={selectedId === null ? "page" : undefined}
        onClick={() => onSelect(null)}
        className={rowClass(selectedId === null)}
      >
        <Vault aria-hidden className="size-4 shrink-0" />
        <span className="truncate">{rootLabel}</span>
      </button>
      {branch(null, 0)}
    </nav>
  );
}
