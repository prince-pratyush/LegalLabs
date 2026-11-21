import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  Filter,
  Pencil,
  Play,
  RotateCcw,
  Square,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import { cn } from "../../cn.js";
import { Button } from "../button.js";
import { ConfirmDialog } from "../confirm-dialog.js";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "../menu.js";
import { Skeleton } from "../status.js";
import { TYPE_NAMES } from "./presets.js";
import { formatUsd, type GridColumn } from "./types.js";

export type SortDirection = "asc" | "desc";

/** "Dry run · 4/10 · $0.02" or "12/40 · $0.31", or null before the first run. */
export function progressLine(column: Pick<GridColumn, "progress" | "dry_run" | "state">) {
  const { done, total, cost_usd } = column.progress;
  if (column.state === "pending" && done === 0) return null;
  const counts = `${done}/${total} · ${formatUsd(cost_usd)}`;
  return column.dry_run ? `Dry run · ${counts}` : counts;
}

/** A column's header: name, type, run progress and its menu (UX §5.2). */
export function ColumnHeader({
  column,
  rowCount,
  sort = null,
  filtered = false,
  onRun,
  onRerun,
  onRunRemaining,
  onEditPrompt,
  onStop,
  onSort,
  onFilter,
  onDelete,
}: {
  column: GridColumn;
  rowCount: number;
  sort?: SortDirection | null;
  filtered?: boolean;
  onRun: () => void;
  onRerun: () => void;
  onRunRemaining: () => void;
  onEditPrompt: () => void;
  onStop: () => void;
  onSort: (direction: SortDirection | null) => void;
  onFilter: () => void;
  onDelete: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const running = column.state === "running";
  const line = progressLine(column);
  const manual = column.type === "manual";
  const SortIcon = sort === "asc" ? ArrowUp : sort === "desc" ? ArrowDown : null;
  return (
    <div className="flex w-full min-w-0 items-center gap-1">
      <div className="grid min-w-0 flex-1 leading-tight">
        <span className="flex min-w-0 items-center gap-1">
          <span className="truncate font-medium text-fg">{column.label}</span>
          {SortIcon && (
            <SortIcon
              role="img"
              aria-label={sort === "asc" ? "Sorted ascending" : "Sorted descending"}
              className="size-3.5 shrink-0 text-fg-muted"
            />
          )}
          {filtered && (
            <Filter role="img" aria-label="Filtered" className="size-3.5 shrink-0 text-accent" />
          )}
        </span>
        <span className="flex min-w-0 items-center gap-1 text-caption font-normal text-fg-muted">
          <span>{TYPE_NAMES[column.type]}</span>
          {line && <span className={cn("truncate", running && "text-accent")}>· {line}</span>}
          {column.dry_run && !running && (
            <Button
              variant="quiet"
              size="sm"
              className="h-auto shrink-0 px-0 text-accent underline underline-offset-2"
              onClick={onRunRemaining}
            >
              Run remaining
            </Button>
          )}
        </span>
      </div>
      {running && (
        <Button
          variant="quiet"
          size="sm"
          onClick={onStop}
          aria-label={`Stop ${column.label}`}
          className="h-6 px-1.5"
        >
          <Square aria-hidden />
          Stop
        </Button>
      )}
      <Menu>
        <MenuTrigger asChild>
          <Button
            variant="quiet"
            size="icon"
            aria-label={`${column.label} menu`}
            className="size-6"
          >
            <ChevronDown aria-hidden />
          </Button>
        </MenuTrigger>
        <MenuContent align="end">
          <MenuItem onSelect={onEditPrompt}>
            <Pencil aria-hidden />
            Edit prompt
          </MenuItem>
          {!manual && (
            <>
              <MenuItem onSelect={onRun} disabled={running}>
                <Play aria-hidden />
                Run column
              </MenuItem>
              <MenuItem onSelect={onRerun} disabled={running}>
                <RotateCcw aria-hidden />
                Re-run (keeps verified cells)
              </MenuItem>
            </>
          )}
          {column.dry_run && (
            <MenuItem onSelect={onRunRemaining} disabled={running}>
              <Play aria-hidden />
              Run remaining rows
            </MenuItem>
          )}
          <MenuSeparator />
          <MenuItem onSelect={onFilter}>
            <Filter aria-hidden />
            Filter…
          </MenuItem>
          <MenuItem onSelect={() => onSort(sort === "asc" ? null : "asc")}>
            <ArrowUp aria-hidden />
            {sort === "asc" ? "Clear sort" : "Sort ascending"}
          </MenuItem>
          <MenuItem onSelect={() => onSort(sort === "desc" ? null : "desc")}>
            <ArrowDown aria-hidden />
            {sort === "desc" ? "Clear sort" : "Sort descending"}
          </MenuItem>
          <MenuSeparator />
          <MenuItem destructive onSelect={() => setConfirming(true)}>
            <Trash2 aria-hidden />
            Delete column
          </MenuItem>
        </MenuContent>
      </Menu>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Delete ${column.label}?`}
        description={`This removes the column and its cells in all ${rowCount.toLocaleString()} rows. It can't be undone.`}
        confirmLabel="Delete column"
        destructive
        onConfirm={onDelete}
      />
    </div>
  );
}

export function ColumnHeaderSkeleton() {
  return (
    <div className="grid w-40 gap-1">
      <Skeleton className="h-3 w-3/4" />
      <Skeleton className="h-2.5 w-1/2" />
    </div>
  );
}
