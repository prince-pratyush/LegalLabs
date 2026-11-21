import type { Cell, Column, ReviewTable, Row, RowFilter, RowSort } from "@legallabs/contracts";
import { cellKey, toast } from "@legallabs/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { messageOf, type RowsPage, tableApi } from "./api.js";

const POLL_MS = 2000;

const isLive = (columns: Column[], cells: Map<string, Cell>) =>
  columns.some((c) => c.state === "running") ||
  [...cells.values()].some((c) => c.status === "queued" || c.status === "running");

const merge = (page: RowsPage, into: Map<string, Cell>) => {
  for (const cell of page.cells) into.set(cellKey(cell.row_id, cell.column_id), cell);
  return into;
};

/**
 * A table's metadata, rows and cells for the current filter and sort, with paging, a refresh
 * that re-reads every loaded page, and polling while anything runs.
 */
export function useTableData(tableId: string, rowFilter: RowFilter, sort: RowSort | null) {
  const [table, setTable] = useState<ReviewTable | null>(null);
  const [columns, setColumns] = useState<Column[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [cells, setCells] = useState<Map<string, Cell>>(new Map());
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(() => Date.now());

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
    [tableId, rowFilter, sort],
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
  }, [cursor, tableId, rowFilter, sort]);

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

  const putCell = useCallback(
    (cell: Cell) => setCells((map) => new Map(map).set(cellKey(cell.row_id, cell.column_id), cell)),
    [],
  );

  return { table, columns, rows, cells, loading, now, refresh, loadMore, putCell };
}
