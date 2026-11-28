import {
  type Cell,
  type Column,
  dependentsOf,
  type FlagColor,
  type PatchCellBody,
  promptForDisplay,
  promptFromDisplay,
  type RowFilter,
  type RowSort,
  type RunColumnBody,
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
  type MentionColumn,
  mentionProblem,
  PromptField,
  ReviewGrid,
  type RunChoice,
  RunDialog,
  SaveTemplateDialog,
  SidePanel,
  Skeleton,
  SyncIndicator,
  SyncPanel,
  toast,
  useMobile,
} from "@legallabs/ui";
import {
  ArrowLeft,
  Blocks,
  Download,
  FilterX,
  LayoutTemplate,
  Play,
  RefreshCw,
} from "lucide-react";
import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { anchorOf, openCitation } from "../viewer/open-citation.js";
import { type CellDetail, download, messageOf, tableApi } from "./api.js";
import { usePageDialogs } from "./use-page-dialogs.js";
import { useSync } from "./use-sync.js";
import { useTableData } from "./use-table-data.js";

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

/** What a run sends: a dry run carries the user's sort and filter, so it tries what they see. */
export function runBody(
  choice: RunChoice | "pending",
  sort: RowSort | null,
  filter: RowFilter,
): RunColumnBody {
  if (choice === "pending") {
    return { scope: "pending", include_verified: false, include_dependents: false };
  }
  const body: RunColumnBody = {
    scope: choice.scope,
    include_verified: choice.include_verified,
    include_dependents: choice.include_dependents === true,
  };
  if (choice.scope !== "dry_run") return body;
  return {
    ...body,
    ...(sort ? { sort } : {}),
    ...(filter.conditions.length > 0 ? { filter } : {}),
  };
}

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

export function TablePage({ tableId, onBack }: { tableId: string; onBack: () => void }) {
  const mobile = useMobile();
  const [filters, setFilters] = useState<Record<string, ColumnFilter>>({});
  const [sort, setSort] = useState<RowSort | null>(null);
  const [active, setActive] = useState<CellRef | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [drawer, setDrawer] = useState(false);
  const [detail, setDetail] = useState<CellDetail | null>(null);
  const { panel, setPanel, run, setRun, exporting, setExporting, adding, setAdding } =
    usePageDialogs();
  const [gridBox, gridHeight] = useHeight<HTMLDivElement>();
  const [savingTemplate, setSavingTemplate] = useState(false);

  const rowFilter = useMemo(() => toRowFilter(filters), [filters]);
  const { table, columns, rows, cells, loading, now, refresh, loadMore, putCell } = useTableData(
    tableId,
    rowFilter,
    sort,
  );
  const rowCount = table?.stats.rows ?? rows.length;
  const {
    sync,
    folders,
    loadFolders,
    save: saveSync,
    syncNow,
  } = useSync(table, () => void refresh());

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
      await tableApi.runColumn(tableId, column.id, runBody(choice, sort, rowFilter));
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
          include_dependents: false,
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

  const mentionable = useMemo(() => columns.map((c) => ({ id: c.id, label: c.label })), [columns]);
  const edges = useMemo(() => new Map(columns.map((c) => [c.id, c.depends_on])), [columns]);
  const labelsOf = (ids: readonly string[]) =>
    ids.flatMap((id) => columns.find((c) => c.id === id)?.label ?? []);

  const openSync = () => {
    setPanel({ kind: "sync" });
    loadFolders().catch((err) => toast.error(messageOf(err)));
  };

  const panelColumn =
    panel && (panel.kind === "filter" || panel.kind === "prompt")
      ? columns.find((c) => c.id === panel.columnId)
      : undefined;

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
        {!mobile && (
          <>
            <AddColumnPopover
              open={adding}
              onOpenChange={setAdding}
              columns={mentionable}
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
          </>
        )}
        {Object.keys(filters).length > 0 && (
          <Button variant="secondary" onClick={() => setFilters({})}>
            <FilterX aria-hidden />
            Clear filters
          </Button>
        )}
        {sync && !mobile && (
          <>
            <SyncIndicator sync={sync} onClick={openSync} />
            <Button variant="secondary" onClick={openSync}>
              <RefreshCw aria-hidden />
              Sync
            </Button>
          </>
        )}
        <Button variant="secondary" onClick={() => setExporting(true)}>
          <Download aria-hidden />
          Export
        </Button>
        {!mobile && (
          <Button variant="secondary" onClick={() => setSavingTemplate(true)}>
            <LayoutTemplate aria-hidden />
            Save as template
          </Button>
        )}
      </header>
      <SaveTemplateDialog
        open={savingTemplate}
        onOpenChange={setSavingTemplate}
        defaultName={table?.name ?? ""}
        columnCount={columns.length}
        onSave={async (request) => {
          try {
            await tableApi.saveTemplate(tableId, request);
            toast.success("Template saved. Find it under Templates.");
          } catch (err) {
            throw new Error(messageOf(err));
          }
        }}
      />
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
                // Read-only on a phone: no column menu to run, edit or delete from.
                if (!full || mobile) return column.label;
                return (
                  <ColumnHeader
                    column={full}
                    rowCount={rowCount}
                    sort={sort?.column_id === full.id ? sort.direction : null}
                    filtered={Boolean(filters[full.id])}
                    uses={labelsOf(full.depends_on)}
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
              {...(mobile
                ? {}
                : {
                    onCellKey,
                    onEdit: (ref: CellRef, value: string) => {
                      const cell = cells.get(cellKey(ref.rowId, ref.columnId));
                      if (cell) void patch(cell, { value_text: value });
                      else toast.error("Run the column before editing this cell.");
                    },
                    onRetry: (ref: CellRef) => void runCell(ref),
                  })}
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
              readOnly={mobile}
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
              {activeColumn.type !== "manual" && !mobile && (
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
        {panel?.kind === "sync" && sync && (
          <SyncPanel
            sync={sync}
            folders={folders}
            onSave={async (settings) => {
              try {
                await saveSync(settings);
              } catch (err) {
                throw new Error(messageOf(err));
              }
            }}
            onSyncNow={async () => {
              try {
                await syncNow();
              } catch (err) {
                throw new Error(messageOf(err));
              }
            }}
            onClose={() => setPanel(null)}
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
            columns={mentionable.filter((c) => c.id !== panelColumn.id)}
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
      {selected.size > 1 && !mobile && (
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
          dependents={labelsOf(dependentsOf(edges, [run.column.id]))}
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
  columns,
  onClose,
  onSave,
}: {
  column: Column;
  /** The table's other columns, which the prompt may refer to. */
  columns: readonly MentionColumn[];
  onClose: () => void;
  onSave: (prompt: string) => void;
}) {
  const shown = promptForDisplay(column.prompt, (id) => columns.find((c) => c.id === id)?.label);
  const [prompt, setPrompt] = useState(shown);
  const problem = mentionProblem(prompt, columns);
  return (
    <SidePanel title={`Edit ${column.label}`} onClose={onClose} width={400}>
      <form
        className="grid gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (!problem) onSave(promptFromDisplay(prompt, columns).prompt);
        }}
      >
        <label htmlFor="column-prompt" className="text-ui font-medium">
          What to look for
        </label>
        <PromptField
          id="column-prompt"
          rows={6}
          value={prompt}
          columns={columns}
          onChange={setPrompt}
          {...(problem ? { "aria-invalid": true as const } : {})}
        />
        {problem && (
          <p role="alert" className="text-caption text-destructive">
            {problem}
          </p>
        )}
        <p className="text-caption text-fg-muted">
          Type @ to use another column's answer. Saving marks this column's answers, and those of
          columns that use it, stale; re-run to refresh them.
        </p>
        <Button type="submit" disabled={prompt.trim() === "" || prompt === shown}>
          Save prompt
        </Button>
      </form>
    </SidePanel>
  );
}
