// biome-ignore-all lint/a11y/useSemanticElements: a table can't hold absolutely placed virtual cells; ARIA grid roles carry the semantics
// biome-ignore-all lint/a11y/useFocusableInteractive: one roving cell takes focus, as the ARIA grid pattern asks
import { createColumnHelper, tableFeatures, useTable } from "@tanstack/react-table";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import { FileText, Lock } from "lucide-react";
import {
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn } from "../../cn.js";
import { Skeleton } from "../status.js";
import { ReviewCell } from "./review-cell.js";
import { cellKey, FLAG_CLASS, type GridCell, type GridColumn, type GridRow } from "./types.js";

export type CellRef = { rowId: string; columnId: string };
export type CellKeyOp = "verify" | "flag" | "lock";

const features = tableFeatures({});

/** Where a key moves the active cell, or null when it doesn't move it. */
export function moveCell(
  key: string,
  at: { row: number; col: number },
  size: { rows: number; cols: number; page: number },
): { row: number; col: number } | null {
  const clamp = (value: number, count: number) => Math.max(0, Math.min(count - 1, value));
  const delta: Record<string, [number, number]> = {
    ArrowDown: [1, 0],
    ArrowUp: [-1, 0],
    ArrowRight: [0, 1],
    ArrowLeft: [0, -1],
    PageDown: [size.page, 0],
    PageUp: [-size.page, 0],
  };
  if (key === "Home") return { row: at.row, col: 0 };
  if (key === "End") return { row: at.row, col: size.cols - 1 };
  const step = delta[key];
  if (!step) return null;
  return { row: clamp(at.row + step[0], size.rows), col: clamp(at.col + step[1], size.cols) };
}

/** Every cell key in the rectangle between two corners. */
export function rectangle(
  rows: readonly GridRow[],
  columns: readonly GridColumn[],
  a: { row: number; col: number },
  b: { row: number; col: number },
): Set<string> {
  const keys = new Set<string>();
  for (let r = Math.min(a.row, b.row); r <= Math.max(a.row, b.row); r++) {
    for (let c = Math.min(a.col, b.col); c <= Math.max(a.col, b.col); c++) {
      const row = rows[r];
      const column = columns[c];
      if (row && column) keys.add(cellKey(row.id, column.id));
    }
  }
  return keys;
}

const KEY_OPS: Record<string, CellKeyOp> = { v: "verify", f: "flag", l: "lock" };

/**
 * The review grid: rows and columns are both virtualised, so only on-screen cells hold DOM.
 * Header row and document column stay fixed while the rest scrolls (UX §5.1).
 */
export function ReviewGrid({
  label,
  rows,
  columns,
  getCell,
  renderHeader = (column) => column.label,
  active,
  onActiveChange,
  selected,
  onSelectionChange,
  onOpen,
  onCellKey,
  onEdit,
  onRetry,
  onEndReached,
  loading = false,
  empty,
  now,
  height = 560,
  firstColumnWidth = 280,
  columnWidth = 220,
  rowHeight = 36,
  headerHeight = 56,
  className,
}: {
  label: string;
  rows: readonly GridRow[];
  columns: readonly GridColumn[];
  getCell: (rowId: string, columnId: string) => GridCell | undefined;
  renderHeader?: (column: GridColumn) => ReactNode;
  active: CellRef | null;
  onActiveChange: (cell: CellRef) => void;
  selected: ReadonlySet<string>;
  onSelectionChange: (keys: Set<string>) => void;
  onOpen?: (cell: CellRef) => void;
  onCellKey?: (op: CellKeyOp, cell: CellRef) => void;
  onEdit?: (cell: CellRef, value: string) => void;
  onRetry?: (cell: CellRef) => void;
  onEndReached?: () => void;
  loading?: boolean;
  empty?: ReactNode;
  now?: number;
  height?: number;
  firstColumnWidth?: number;
  columnWidth?: number;
  rowHeight?: number;
  headerHeight?: number;
  className?: string;
}) {
  // TanStack Table owns row and column order; sorting and filtering happen on the server.
  const helper = useMemo(() => createColumnHelper<typeof features, GridRow>(), []);
  const defs = useMemo(
    () =>
      helper.columns(
        columns.map((column) => helper.accessor((row: GridRow) => row.id, { id: column.id })),
      ),
    [columns, helper],
  );
  const data = useMemo(() => [...rows], [rows]);
  const table = useTable({ features, columns: defs, data, getRowId: (row: GridRow) => row.id });
  const model = table.getRowModel().rows.map((row) => row.original);
  const byId = useMemo(() => new Map(columns.map((column) => [column.id, column])), [columns]);
  const order = table
    .getAllLeafColumns()
    .map((column) => byId.get(column.id))
    .filter((column): column is GridColumn => Boolean(column));

  const at = useMemo(() => {
    const row = active ? model.findIndex((r) => r.id === active.rowId) : -1;
    const col = active ? order.findIndex((c) => c.id === active.columnId) : -1;
    return { row: Math.max(0, row), col: Math.max(0, col) };
  }, [active, model, order]);
  const atRef = useRef(at);
  atRef.current = at;
  const anchor = useRef(at);

  const scroller = useRef<HTMLDivElement>(null);
  const rowV = useVirtualizer({
    count: model.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => rowHeight,
    getItemKey: (index) => model[index]?.id ?? index,
    overscan: 10,
    scrollPaddingStart: headerHeight,
    // Keep the active cell mounted, so the grid never loses its Tab stop.
    rangeExtractor: (range) =>
      [...new Set([...defaultRangeExtractor(range), atRef.current.row])]
        .filter((index) => index < model.length)
        .sort((a, b) => a - b),
  });
  const colV = useVirtualizer({
    horizontal: true,
    count: order.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => columnWidth,
    getItemKey: (index) => order[index]?.id ?? index,
    overscan: 3,
    scrollPaddingStart: firstColumnWidth,
    rangeExtractor: (range) =>
      [...new Set([...defaultRangeExtractor(range), atRef.current.col])]
        .filter((index) => index < order.length)
        .sort((a, b) => a - b),
  });
  const rowItems = rowV.getVirtualItems();
  const colItems = colV.getVirtualItems();
  const width = firstColumnWidth + colV.getTotalSize();

  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [focusing, setFocusing] = useState(false);
  useEffect(() => {
    if (!focusing || !active || editing) return;
    scroller.current
      ?.querySelector<HTMLElement>(`[data-cell="${cellKey(active.rowId, active.columnId)}"]`)
      ?.focus();
    setFocusing(false);
  });

  const lastAsked = useRef(-1);
  const lastIndex = rowItems.at(-1)?.index ?? -1;
  useEffect(() => {
    if (!onEndReached || model.length === 0 || lastIndex < model.length - 5) return;
    if (lastAsked.current === model.length) return;
    lastAsked.current = model.length;
    onEndReached();
  }, [lastIndex, model.length, onEndReached]);

  const refAt = (row: number, col: number): CellRef | null => {
    const r = model[row];
    const c = order[col];
    return r && c ? { rowId: r.id, columnId: c.id } : null;
  };

  const goTo = (row: number, col: number) => {
    const ref = refAt(row, col);
    if (!ref) return;
    onActiveChange(ref);
    rowV.scrollToIndex(row);
    colV.scrollToIndex(col);
    setFocusing(true);
  };

  const startEdit = (ref: CellRef) => {
    const cell = getCell(ref.rowId, ref.columnId);
    if (!onEdit || cell?.locked) return;
    setDraft(cell?.value_text ?? "");
    setEditing(cellKey(ref.rowId, ref.columnId));
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (editing) return;
    const ref = refAt(at.row, at.col);
    const page = Math.max(1, Math.floor((height - headerHeight) / rowHeight) - 1);
    const next = moveCell(event.key, at, { rows: model.length, cols: order.length, page });
    if (next) {
      event.preventDefault();
      if (event.shiftKey) onSelectionChange(rectangle(model, order, anchor.current, next));
      else anchor.current = next;
      goTo(next.row, next.col);
      return;
    }
    if (!ref) return;
    const op = KEY_OPS[event.key.toLowerCase()];
    if (op && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      onCellKey?.(op, ref);
    } else if (event.key === "Enter") {
      event.preventDefault();
      onOpen?.(ref);
    } else if (event.key === "F2") {
      event.preventDefault();
      startEdit(ref);
    } else if (event.key === "Escape" && selected.size > 0) {
      // Clear the selection first; a second Esc reaches the page (and closes the drawer).
      event.stopPropagation();
      onSelectionChange(new Set());
    } else if (event.key.toLowerCase() === "a" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      onSelectionChange(
        rectangle(model, order, { row: 0, col: at.col }, { row: model.length - 1, col: at.col }),
      );
    }
  };

  const onCellClick = (event: MouseEvent, row: number, col: number) => {
    const ref = refAt(row, col);
    if (!ref) return;
    const key = cellKey(ref.rowId, ref.columnId);
    if (event.shiftKey) {
      onSelectionChange(rectangle(model, order, anchor.current, { row, col }));
    } else if (event.metaKey || event.ctrlKey) {
      const next = new Set(selected);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      onSelectionChange(next);
      anchor.current = { row, col };
    } else {
      anchor.current = { row, col };
      if (selected.size > 0) onSelectionChange(new Set());
      onOpen?.(ref);
    }
    onActiveChange(ref);
    setFocusing(true);
  };

  const commit = (ref: CellRef) => {
    setEditing(null);
    const before = getCell(ref.rowId, ref.columnId)?.value_text ?? "";
    if (draft !== before) onEdit?.(ref, draft);
    setFocusing(true);
  };

  return (
    <div
      ref={scroller}
      role="grid"
      aria-label={label}
      aria-rowcount={model.length + 1}
      aria-colcount={order.length + 1}
      aria-multiselectable
      aria-busy={loading || undefined}
      onKeyDown={onKeyDown}
      style={{ height }}
      className={cn("relative overflow-auto rounded-md border border-border bg-bg", className)}
    >
      <div className="relative" style={{ width, height: headerHeight + rowV.getTotalSize() }}>
        <div
          role="row"
          aria-rowindex={1}
          className="sticky top-0 z-20 border-b border-border bg-bg-subtle"
          style={{ width, height: headerHeight }}
        >
          <div
            role="columnheader"
            aria-colindex={1}
            className="sticky left-0 z-10 flex h-full items-center border-r border-border bg-bg-subtle px-3 font-medium text-fg-muted"
            style={{ width: firstColumnWidth }}
          >
            Document
          </div>
          {colItems.map((item) => {
            const column = order[item.index];
            if (!column) return null;
            return (
              <div
                key={item.key}
                role="columnheader"
                aria-colindex={item.index + 2}
                className="absolute top-0 flex h-full items-center border-r border-border px-2 font-medium"
                style={{ left: firstColumnWidth + item.start, width: item.size }}
              >
                {renderHeader(column)}
              </div>
            );
          })}
        </div>
        {loading ? (
          Array.from({ length: 6 }, (_, i) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: placeholders have no identity
              key={i}
              aria-hidden
              className="flex items-center gap-4 border-b border-border px-3"
              style={{ height: rowHeight }}
            >
              <Skeleton className="h-3 w-48" />
              <Skeleton className="h-3 w-32" />
              <Skeleton className="h-3 w-32" />
            </div>
          ))
        ) : model.length === 0 ? (
          <div role="row" aria-rowindex={2}>
            <div
              role="gridcell"
              className="sticky left-0 p-6"
              style={{ width: Math.min(width, 640) }}
            >
              {empty}
            </div>
          </div>
        ) : (
          rowItems.map((rowItem) => {
            const row = model[rowItem.index];
            if (!row) return null;
            return (
              <div
                key={rowItem.key}
                role="row"
                aria-rowindex={rowItem.index + 2}
                className="absolute left-0 border-b border-border"
                style={{ top: headerHeight + rowItem.start, height: rowItem.size, width }}
              >
                <div
                  role="rowheader"
                  aria-colindex={1}
                  className="sticky left-0 z-10 flex h-full items-center gap-2 border-r border-border bg-bg px-3"
                  style={{ width: firstColumnWidth }}
                >
                  {row.restricted ? (
                    <span className="inline-flex items-center gap-1 text-fg-muted">
                      <Lock aria-hidden className="size-3.5" />
                      Restricted
                    </span>
                  ) : (
                    <>
                      <FileText aria-hidden className="size-3.5 shrink-0 text-fg-muted" />
                      <span className="truncate">
                        {row.documents.map((d) => d.name).join(", ")}
                      </span>
                    </>
                  )}
                </div>
                {colItems.map((colItem) => {
                  const column = order[colItem.index];
                  if (!column) return null;
                  const ref = { rowId: row.id, columnId: column.id };
                  const key = cellKey(row.id, column.id);
                  const cell = row.restricted ? undefined : getCell(row.id, column.id);
                  const isActive = rowItem.index === at.row && colItem.index === at.col;
                  const isSelected = selected.has(key);
                  return (
                    // biome-ignore lint/a11y/useKeyWithClickEvents: the grid handles keys for every cell
                    <div
                      key={colItem.key}
                      role="gridcell"
                      aria-colindex={colItem.index + 2}
                      aria-selected={isSelected}
                      data-cell={key}
                      data-active={isActive || undefined}
                      tabIndex={isActive ? 0 : -1}
                      onClick={(event) => onCellClick(event, rowItem.index, colItem.index)}
                      onDoubleClick={() => startEdit(ref)}
                      className={cn(
                        "absolute top-0 flex h-full cursor-default items-center border-r border-border px-2 text-dense -outline-offset-2",
                        cell?.status === "pending" || !cell ? "border-dotted" : undefined,
                        cell?.flag_color && ["border-l-[3px]", FLAG_CLASS[cell.flag_color].border],
                        isSelected && "tint-selected",
                        isActive && "outline-2 outline-accent outline-solid",
                      )}
                      style={{ left: firstColumnWidth + colItem.start, width: colItem.size }}
                    >
                      {editing === key ? (
                        <input
                          // biome-ignore lint/a11y/noAutofocus: editing starts where the user double-clicked
                          autoFocus
                          aria-label={`Edit ${column.label}`}
                          value={draft}
                          onChange={(event) => setDraft(event.target.value)}
                          onBlur={() => commit(ref)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              commit(ref);
                            } else if (event.key === "Escape") {
                              event.stopPropagation();
                              setEditing(null);
                              setFocusing(true);
                            }
                          }}
                          className="h-7 w-full rounded-sm border border-control bg-bg px-1"
                        />
                      ) : row.restricted ? (
                        <span className="text-fg-muted">Restricted</span>
                      ) : (
                        <ReviewCell
                          cell={cell}
                          {...(now === undefined ? {} : { now })}
                          {...(onRetry ? { onRetry: () => onRetry(ref) } : {})}
                          {...(onOpen ? { onLooked: () => onOpen(ref) } : {})}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
