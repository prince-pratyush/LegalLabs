import type {
  Cell,
  Column,
  FlagColor,
  PatchCellBody,
  ReviewTable,
  Row,
  RowFilter,
  RowSort,
} from "@legallabs/contracts";
import {
  AddColumnPopover,
  BulkBar,
  Button,
  CellDrawer,
  type CellKeyOp,
  type CellRef,
  ColumnBuilder,
  type ColumnFilter,
  ColumnHeader,
  cellKey,
  type DrawerCitation,
  ExportDialog,
  FilterPanel,
  formatUsd,
  ReviewGrid,
  type RunChoice,
  RunDialog,
  SidePanel,
  Skeleton,
  Textarea,
  toast,
} from "@legallabs/ui";
import { ArrowLeft, Blocks, Download, FilterX, Play } from "lucide-react";
import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { anchorOf, openCitation } from "../viewer/open-citation.js";
import { type CellDetail, download, messageOf, type RowsPage, tableApi } from "./api.js";

const POLL_MS = 2000;
const FLAG_CYCLE: (FlagColor | null)[] = [
  null,
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
];

/** F cycles a cell's flag through the six colours and back to none. */
export const nextFlag = (current: FlagColor | null) =>
  FLAG_CYCLE[(FLAG_CYCLE.indexOf(current) + 1) % FLAG_CYCLE.length] ?? null;

export const toRowFilter = (filters: Record<string, ColumnFilter>): RowFilter => ({
  conditions: Object.entries(filters).map(([column_id, f]) => ({ column_id, ...f })),
});

/** What V, F and L change on a cell, or null when the key can't apply. */
export function keyPatch(op: CellKeyOp, cell: Cell): PatchCellBody | null {
  if (op === "lock") return { locked: !cell.locked };
  if (cell.locked) return null;
  if (op === "verify") return { verified: !cell.verified_at };
  return { flag_color: nextFlag(cell.flag_color) };
}

const isLive = (columns: Column[], cells: Map<string, Cell>) =>
  columns.some((c) => c.state === "running") ||
  [...cells.values()].some((c) => c.status === "queued" || c.status === "running");

function useHeight<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [height, setHeight] = useState(480);
  useEffect(() => {
    const element = ref.current;
    // Old browsers and jsdom lack ResizeObserver; the grid then keeps its first height.
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setHeight(element.clientHeight || 480));
    observer.observe(element);
    setHeight(element.clientHeight || 480);
    return () => observer.disconnect();
  }, []);
  return [ref, height] as const;
}

type Panel =
  | { kind: "builder" }
  | { kind: "filter"; columnId: string }
  | { kind: "prompt"; columnId: string };

export function TablePage({ tableId, onBack }: { tableId: string; onBack: () => void }) {
  const [table, setTable] = useState<ReviewTable | null>(null);
  const [columns, setColumns] = useState<Column[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [cells, setCells] = useState<Map<string, Cell>>(new Map());
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState<Record<string, ColumnFilter>>({});
  const [sort, setSort] = useState<RowSort | null>(null);
  const [active, setActive] = useState<CellRef | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [drawer, setDrawer] = useState(false);
  const [detail, setDetail] = useState<CellDetail | null>(null);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [run, setRun] = useState<{ column: Column; rerun: boolean } | null>(null);
  const [exporting, setExporting] = useState(false);
  const [adding, setAdding] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [gridBox, gridHeight] = useHeight<HTMLDivElement>();

  const rowFilter = useMemo(() => toRowFilter(filters), [filters]);
  const rowCount = table?.stats.rows ?? rows.length;

  const merge = useCallback((page: RowsPage, into: Map<string, Cell>) => {
    for (const cell of page.cells) into.set(cellKey(cell.row_id, cell.column_id), cell);
    return into;
  }, []);

  const loadMeta = useCallback(async () => {
    const next = await tableApi.get(tableId);
    setTable(next.table);
    setColumns(next.columns);
  }, [tableId]);

  // Re-reads every loaded page, so polling keeps scrolled-to rows fresh too.
  const loadRows = useCallback(
    async (count: number) => {
      let pageCursor: string | null = null;
      const nextRows: Row[] = [];
      const nextCells = new Map<string, Cell>();
      do {
        const page: RowsPage = await tableApi.rows(tableId, {
          cursor: pageCursor,
          filter: rowFilter,
          sort,
        });
        nextRows.push(...page.rows);
        merge(page, nextCells);
        pageCursor = page.next_cursor;
      } while (pageCursor && nextRows.length < count);
      setRows(nextRows);
      setCells(nextCells);
      setCursor(pageCursor);
    },
    [tableId, rowFilter, sort, merge],
  );

  const refresh = useCallback(
    () =>
      Promise.all([loadMeta(), loadRows(rows.length)]).catch((err) => toast.error(messageOf(err))),
    [loadMeta, loadRows, rows.length],
  );

  useEffect(() => {
    setLoading(true);
    Promise.all([loadMeta(), loadRows(0)])
      .catch((err) => toast.error(messageOf(err)))
      .finally(() => setLoading(false));
  }, [loadMeta, loadRows]);

  const loadMore = useCallback(() => {
    if (!cursor) return;
    tableApi.rows(tableId, { cursor, filter: rowFilter, sort }).then(
      (page) => {
        setRows((list) => [...list, ...page.rows]);
        setCells((map) => merge(page, new Map(map)));
        setCursor(page.next_cursor);
      },
      (err) => toast.error(messageOf(err)),
    );
  }, [cursor, tableId, rowFilter, sort, merge]);

  // Live progress: poll while anything runs; the clock drives "running 12 s".
  const live = isLive(columns, cells);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    if (!live) return;
    const poll = setInterval(() => void refreshRef.current(), POLL_MS);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [live]);

  const activeCell = active ? cells.get(cellKey(active.rowId, active.columnId)) : undefined;
  const activeColumn = columns.find((c) => c.id === active?.columnId);
  const activeRow = rows.find((r) => r.id === active?.rowId);

  // The drawer follows the active cell, including while it updates during a run.
  const activeId = activeCell?.id;
  const activeStamp = activeCell?.updated_at;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a changed cell (new updated_at) refetches its detail
  useEffect(() => {
    if (!drawer || !activeId) {
      setDetail(null);
      return;
    }
    let current = true;
    tableApi.cell(tableId, activeId).then(
      (next) => current && setDetail(next),
      (err) => toast.error(messageOf(err)),
    );
    return () => {
      current = false;
    };
  }, [drawer, activeId, activeStamp, tableId]);

  const putCell = (cell: Cell) =>
    setCells((map) => new Map(map).set(cellKey(cell.row_id, cell.column_id), cell));

  const patch = async (cell: Cell, body: PatchCellBody) => {
    try {
      putCell(await tableApi.patchCell(tableId, cell.id, body));
    } catch (err) {
      toast.error(messageOf(err));
    }
  };

  const onCellKey = (op: CellKeyOp, ref: CellRef) => {
    const cell = cells.get(cellKey(ref.rowId, ref.columnId));
    if (!cell) return;
    const body = keyPatch(op, cell);
    if (body) void patch(cell, body);
    else toast.error("That cell is locked. Unlock it to change it.");
  };

  const runColumn = async (column: Column, choice: RunChoice | "pending") => {
    try {
      await tableApi.runColumn(
        tableId,
        column.id,
        choice === "pending"
          ? { scope: "pending", include_verified: false }
          : { scope: choice.scope, include_verified: choice.include_verified },
      );
      await refresh();
    } catch (err) {
      toast.error(messageOf(err));
    }
  };

  const runCell = async (ref: CellRef) => {
    const cell = cells.get(cellKey(ref.rowId, ref.columnId));
    try {
      if (cell) await tableApi.rerunCell(tableId, cell.id);
      else
        await tableApi.runColumn(tableId, ref.columnId, {
          scope: { row_ids: [ref.rowId] },
          include_verified: false,
        });
      await refresh();
    } catch (err) {
      toast.error(messageOf(err));
    }
  };

  const runColumnId = run?.column.id;
  const estimateRun = useCallback(
    (choice: RunChoice) =>
      tableApi.estimate(tableId, {
        column_ids: runColumnId ? [runColumnId] : [],
        scope: choice.scope,
        include_verified: choice.include_verified,
      }),
    [tableId, runColumnId],
  );

  const selectedCells = [...selected]
    .map((key) => cells.get(key))
    .filter((cell): cell is Cell => Boolean(cell));
  const selectedColumns = new Set(selectedCells.map((c) => c.column_id));

  const changeFilter = (columnId: string, filter: ColumnFilter | null) => {
    setFilters(({ [columnId]: _, ...rest }) => (filter ? { ...rest, [columnId]: filter } : rest));
    setPanel(null);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape" && drawer && !event.defaultPrevented) setDrawer(false);
  };

  const openCite = (citation: DrawerCitation) => {
    const all = detail?.citations ?? [];
    const anchors = all.map((c) => anchorOf(c)).filter((a) => a !== null);
    const full = all.find((c) => c.id === citation.id);
    const anchor = full ? anchorOf(full) : null;
    if (anchor) openCitation(anchor, { context: anchors });
  };

  const panelColumn =
    panel && panel.kind !== "builder" ? columns.find((c) => c.id === panel.columnId) : undefined;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Esc closes the drawer from anywhere on the page
    <div className="flex h-dvh flex-col" onKeyDown={onKeyDown}>
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        <Button variant="quiet" size="icon" aria-label="Back to review tables" onClick={onBack}>
          <ArrowLeft aria-hidden />
        </Button>
        <div className="grid min-w-0 flex-1">
          {table ? (
            <>
              <h1 className="truncate text-section font-semibold">{table.name}</h1>
              <p className="text-caption text-fg-muted">
                {table.source_kind === "vault" ? "Vault" : "Uploaded files"} ·{" "}
                {table.stats.rows.toLocaleString()} rows · {columns.length} columns ·{" "}
                {formatUsd(table.stats.cost_usd)} spent
              </p>
            </>
          ) : (
            <Skeleton className="h-5 w-64" />
          )}
        </div>
        <AddColumnPopover
          open={adding}
          onOpenChange={setAdding}
          onAdd={async (column) => {
            try {
              await tableApi.createColumn(tableId, column);
              setAdding(false);
              await refresh();
            } catch (err) {
              toast.error(messageOf(err));
            }
          }}
        />
        <Button variant="secondary" onClick={() => setPanel({ kind: "builder" })}>
          <Blocks aria-hidden />
          Column builder
        </Button>
        {Object.keys(filters).length > 0 && (
          <Button variant="secondary" onClick={() => setFilters({})}>
            <FilterX aria-hidden />
            Clear filters
          </Button>
        )}
        <Button variant="secondary" onClick={() => setExporting(true)}>
          <Download aria-hidden />
          Export
        </Button>
      </header>
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <div ref={gridBox} className="min-h-0 flex-1 p-2">
            <ReviewGrid
              label={table?.name ?? "Review table"}
              rows={rows}
              columns={columns}
              getCell={(rowId, columnId) => cells.get(cellKey(rowId, columnId))}
              renderHeader={(column) => {
                const full = columns.find((c) => c.id === column.id);
                if (!full) return column.label;
                return (
                  <ColumnHeader
                    column={full}
                    rowCount={rowCount}
                    sort={sort?.column_id === full.id ? sort.direction : null}
                    filtered={Boolean(filters[full.id])}
                    onRun={() => setRun({ column: full, rerun: false })}
                    onRerun={() => setRun({ column: full, rerun: true })}
                    onRunRemaining={() => void runColumn(full, "pending")}
                    onEditPrompt={() => setPanel({ kind: "prompt", columnId: full.id })}
                    onStop={() => {
                      if (full.run_id)
                        tableApi
                          .cancel(full.run_id)
                          .then(refresh, (err) => toast.error(messageOf(err)));
                    }}
                    onSort={(direction) =>
                      setSort(direction ? { column_id: full.id, direction } : null)
                    }
                    onFilter={() => setPanel({ kind: "filter", columnId: full.id })}
                    onDelete={() =>
                      tableApi
                        .deleteColumn(tableId, full.id)
                        .then(refresh, (err) => toast.error(messageOf(err)))
                    }
                  />
                );
              }}
              active={active}
              onActiveChange={setActive}
              selected={selected}
              onSelectionChange={setSelected}
              onOpen={(ref) => {
                setActive(ref);
                setDrawer(true);
              }}
              onCellKey={onCellKey}
              onEdit={(ref, value) => {
                const cell = cells.get(cellKey(ref.rowId, ref.columnId));
                if (cell) void patch(cell, { value_text: value });
                else toast.error("Run the column before editing this cell.");
              }}
              onRetry={(ref) => void runCell(ref)}
              onEndReached={loadMore}
              loading={loading}
              now={now}
              height={Math.max(240, gridHeight - 16)}
              empty={
                <p className="text-fg-muted">No rows match. Clear the filters to see every row.</p>
              }
            />
          </div>
          {drawer && activeColumn && activeRow && activeCell && (
            <CellDrawer
              columnLabel={activeColumn.label}
              documentName={activeRow.documents.map((d) => d.name).join(", ") || "Restricted"}
              detail={detail}
              onClose={() => setDrawer(false)}
              onRerun={() => active && void runCell(active)}
              onVerify={(verified) => void patch(activeCell, { verified })}
              onFlag={(flag_color) => void patch(activeCell, { flag_color })}
              onLock={(locked) => void patch(activeCell, { locked })}
              onSave={(value_text) => void patch(activeCell, { value_text })}
              onOpenCitation={openCite}
            />
          )}
          {drawer && activeColumn && activeRow && !activeCell && (
            <section
              aria-label="Cell not run"
              className="flex items-center gap-3 border-t border-border bg-bg-subtle px-4 py-3"
            >
              <p className="flex-1 text-ui">
                {activeColumn.label} hasn't run for {activeRow.documents[0]?.name ?? "this row"}.
              </p>
              {activeColumn.type !== "manual" && (
                <Button size="sm" onClick={() => active && void runCell(active)}>
                  <Play aria-hidden />
                  Run cell
                </Button>
              )}
              <Button variant="quiet" size="sm" onClick={() => setDrawer(false)}>
                Close
              </Button>
            </section>
          )}
        </div>
        {panel?.kind === "builder" && (
          <ColumnBuilder
            instructions={table?.instructions ?? ""}
            onClose={() => setPanel(null)}
            onGenerate={async (description) => {
              try {
                return await tableApi.generate(tableId, description);
              } catch (err) {
                throw new Error(messageOf(err));
              }
            }}
            onAdd={async (list) => {
              try {
                for (const column of list) await tableApi.createColumn(tableId, column);
              } finally {
                await refresh();
              }
            }}
          />
        )}
        {panel?.kind === "filter" && panelColumn && (
          <SidePanel
            title={`Filter ${panelColumn.label}`}
            onClose={() => setPanel(null)}
            width={360}
          >
            <FilterPanel
              columnLabel={panelColumn.label}
              value={filters[panelColumn.id] ?? null}
              onApply={(filter) => changeFilter(panelColumn.id, filter)}
            />
          </SidePanel>
        )}
        {panel?.kind === "prompt" && panelColumn && (
          <PromptPanel
            column={panelColumn}
            onClose={() => setPanel(null)}
            onSave={async (prompt) => {
              try {
                await tableApi.updateColumn(tableId, panelColumn.id, { prompt });
                setPanel(null);
                await refresh();
              } catch (err) {
                toast.error(messageOf(err));
              }
            }}
          />
        )}
      </div>
      {selected.size > 1 && (
        <BulkBar
          cellCount={selectedCells.length}
          columnCount={selectedColumns.size}
          estimate={() =>
            tableApi.estimate(tableId, {
              column_ids: [...selectedColumns],
              scope: { row_ids: [...new Set(selectedCells.map((c) => c.row_id))] },
              include_verified: false,
            })
          }
          onConfirm={async ({ op, flag_color }) => {
            try {
              await tableApi.bulk(tableId, {
                cell_ids: selectedCells.map((c) => c.id),
                op,
                ...(flag_color ? { flag_color } : {}),
              });
            } catch (err) {
              throw new Error(messageOf(err));
            }
            setSelected(new Set());
            await refresh();
          }}
          onClear={() => setSelected(new Set())}
        />
      )}
      {run && (
        <RunDialog
          open
          onOpenChange={(open) => !open && setRun(null)}
          columnLabel={run.column.label}
          rowCount={rowCount}
          rerun={run.rerun}
          estimate={estimateRun}
          onRun={(choice) => void runColumn(run.column, choice)}
        />
      )}
      <ExportDialog
        open={exporting}
        onOpenChange={setExporting}
        filtered={rowFilter.conditions.length > 0}
        onExport={async (choice) => {
          try {
            const file = await tableApi.export(tableId, {
              ...choice,
              ...(rowFilter.conditions.length > 0 ? { only_filtered_rows: rowFilter } : {}),
            });
            download(file.blob, file.filename);
          } catch (err) {
            throw new Error(messageOf(err));
          }
        }}
      />
    </div>
  );
}

function PromptPanel({
  column,
  onClose,
  onSave,
}: {
  column: Column;
  onClose: () => void;
  onSave: (prompt: string) => void;
}) {
  const [prompt, setPrompt] = useState(column.prompt);
  return (
    <SidePanel title={`Edit ${column.label}`} onClose={onClose} width={400}>
      <form
        className="grid gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          onSave(prompt);
        }}
      >
        <label htmlFor="column-prompt" className="text-ui font-medium">
          What to look for
        </label>
        <Textarea
          id="column-prompt"
          rows={6}
          maxLength={4000}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
        <p className="text-caption text-fg-muted">
          Saving marks this column's answers stale; re-run to refresh them.
        </p>
        <Button type="submit" disabled={prompt.trim() === "" || prompt === column.prompt}>
          Save prompt
        </Button>
      </form>
    </SidePanel>
  );
}
