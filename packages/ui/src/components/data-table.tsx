import {
  createColumnHelper,
  createSortedRowModel,
  rowSortingFeature,
  sortFns,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import {
  Fragment,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn } from "../cn.js";
import { Skeleton } from "./status.js";

export type TableColumn<T extends object> = {
  id: string;
  header: string;
  cell: (row: T) => ReactNode;
  /** Present when the column can be sorted. */
  sortValue?: (row: T) => string | number;
  /** Numbers and money sit on the right so their digits line up. */
  align?: "start" | "end";
  width?: number;
};

const features = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns,
});

/** Where a key moves the active row, or null when the key doesn't move it. */
export function targetRow(key: string, active: number, page: number, count: number) {
  const next =
    key === "ArrowDown"
      ? active + 1
      : key === "ArrowUp"
        ? active - 1
        : key === "PageDown"
          ? active + page
          : key === "PageUp"
            ? active - page
            : key === "Home"
              ? 0
              : key === "End"
                ? count - 1
                : null;
  return next === null ? null : Math.max(0, Math.min(count - 1, next));
}

const rowHeight = (element: HTMLElement | null) =>
  Number.parseFloat(element ? getComputedStyle(element).getPropertyValue("--row-height") : "") ||
  40;

/** Renders only the visible rows, so 10,000 scroll as smoothly as 10. */
export function DataTable<T extends object>({
  label,
  columns,
  rows,
  getRowId,
  onActivate,
  loading = false,
  empty,
  height = 480,
  className,
}: {
  label: string;
  columns: readonly TableColumn<T>[];
  rows: readonly T[];
  getRowId: (row: T) => string;
  onActivate?: (row: T) => void;
  loading?: boolean;
  empty: ReactNode;
  height?: number;
  className?: string;
}) {
  const helper = useMemo(() => createColumnHelper<typeof features, T>(), []);
  const defs = useMemo(
    () =>
      helper.columns(
        columns.map((column) =>
          helper.accessor((row: T) => column.sortValue?.(row) ?? "", {
            id: column.id,
            enableSorting: Boolean(column.sortValue),
          }),
        ),
      ),
    [columns, helper],
  );
  const data = useMemo(() => [...rows], [rows]);
  const table = useTable({ features, columns: defs, data, getRowId: (row: T) => getRowId(row) });
  const model = table.getRowModel().rows;
  const byId = useMemo(() => new Map(columns.map((column) => [column.id, column])), [columns]);

  const scroller = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const activeRef = useRef(active);
  activeRef.current = active;
  const virtualizer = useVirtualizer({
    count: model.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => rowHeight(scroller.current),
    getItemKey: (index) => model[index]?.id ?? index,
    overscan: 8,
    // The header is one row tall; without this, rows scroll in under it.
    scrollPaddingStart: rowHeight(scroller.current),
    // Keep the active row mounted so the table never loses its Tab stop.
    rangeExtractor: (range) =>
      [...new Set([...defaultRangeExtractor(range), activeRef.current])]
        .filter((index) => index < model.length)
        .sort((a, b) => a - b),
  });
  const items = virtualizer.getVirtualItems();
  const top = items[0]?.start ?? 0;
  const bottom = virtualizer.getTotalSize() - (items.at(-1)?.end ?? 0);

  const [focusing, setFocusing] = useState(false);
  useEffect(() => {
    if (!focusing) return;
    scroller.current?.querySelector<HTMLElement>(`[aria-rowindex="${active + 2}"]`)?.focus();
    setFocusing(false);
  });

  const move = (next: number) => {
    setActive(next);
    virtualizer.scrollToIndex(next);
    setFocusing(true);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const page = Math.max(1, Math.floor(height / rowHeight(scroller.current)) - 1);
    const target = targetRow(event.key, active, page, model.length);
    if (target !== null) {
      event.preventDefault();
      move(target);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const row = model[active];
      if (row) onActivate?.(row.original);
    }
  };

  const cellClass = (column: TableColumn<T> | undefined) =>
    cn("px-3 text-left", column?.align === "end" && "text-right");

  return (
    <div
      ref={scroller}
      style={{ maxHeight: height }}
      className={cn("overflow-auto rounded-md border border-border bg-bg", className)}
    >
      <table
        // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: arrow keys move between rows, which a grid announces
        role="grid"
        aria-label={label}
        aria-rowcount={model.length + 1}
        aria-colcount={columns.length}
        aria-busy={loading || undefined}
        className="w-full border-collapse text-dense tabular-nums"
      >
        <thead>
          {table.getHeaderGroups().map((group) => (
            <tr key={group.id} aria-rowindex={1}>
              {group.headers.map((header) => {
                const column = byId.get(header.column.id);
                const sorted = header.column.getIsSorted();
                const Icon =
                  sorted === "asc" ? ArrowUp : sorted === "desc" ? ArrowDown : ArrowUpDown;
                return (
                  <th
                    key={header.id}
                    scope="col"
                    aria-sort={
                      sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : undefined
                    }
                    style={column?.width ? { width: column.width } : undefined}
                    className={cn(
                      cellClass(column),
                      "sticky top-0 z-10 h-row border-b border-border bg-bg-subtle font-medium text-fg-muted",
                    )}
                  >
                    {header.column.getCanSort() ? (
                      <button
                        type="button"
                        onClick={header.column.getToggleSortingHandler()}
                        className={cn(
                          "inline-flex items-center gap-1 rounded-sm hover:text-fg",
                          column?.align === "end" && "flex-row-reverse",
                        )}
                      >
                        {column?.header}
                        <Icon aria-hidden className={cn("size-4", !sorted && "opacity-50")} />
                      </button>
                    ) : (
                      column?.header
                    )}
                  </th>
                );
              })}
            </tr>
          ))}
        </thead>
        <tbody onKeyDown={onKeyDown}>
          {loading ? (
            Array.from({ length: 5 }, (_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: placeholders have no identity
              <tr key={i} aria-hidden className="h-row border-b border-border">
                {columns.map((column) => (
                  <td key={column.id} className="px-3">
                    <Skeleton className="h-3 w-3/4" />
                  </td>
                ))}
              </tr>
            ))
          ) : model.length === 0 ? (
            <tr>
              <td colSpan={columns.length}>{empty}</td>
            </tr>
          ) : (
            <>
              {top > 0 && <tr aria-hidden style={{ height: top }} />}
              {items.map((item, i) => {
                const row = model[item.index];
                if (!row) return null;
                const gap = item.start - (items[i - 1]?.end ?? item.start);
                return (
                  <Fragment key={row.id}>
                    {gap > 0 && <tr aria-hidden style={{ height: gap }} />}
                    <tr
                      aria-rowindex={item.index + 2}
                      data-active={item.index === active || undefined}
                      tabIndex={item.index === active ? 0 : -1}
                      onClick={(event) => {
                        setActive(item.index);
                        event.currentTarget.focus();
                      }}
                      onDoubleClick={() => onActivate?.(row.original)}
                      className="h-row border-b border-border hover:tint-hover data-active:tint-selected"
                    >
                      {columns.map((column) => (
                        <td key={column.id} className={cellClass(column)}>
                          {column.cell(row.original)}
                        </td>
                      ))}
                    </tr>
                  </Fragment>
                );
              })}
              {bottom > 0 && <tr aria-hidden style={{ height: bottom }} />}
            </>
          )}
        </tbody>
      </table>
    </div>
  );
}
