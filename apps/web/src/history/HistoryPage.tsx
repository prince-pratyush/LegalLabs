import {
  Button,
  EmptyState,
  type HistoryFilters,
  type HistoryRow,
  HistoryTable,
  NO_FILTERS,
} from "@legallabs/ui";
import { useEffect, useState } from "react";
import { api, messageOf } from "../api.js";
import { navigate, paths } from "../router.js";
import { Shell } from "../shell.js";
import { historyQuery, toRow } from "./query.js";

const SEARCH_DELAY_MS = 250;

export function HistoryPage({ onFavourite }: { onFavourite?: () => void }) {
  const [filters, setFilters] = useState<HistoryFilters>(NO_FILTERS);
  const [applied, setApplied] = useState<HistoryFilters>(NO_FILTERS);
  const [rows, setRows] = useState<HistoryRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  // Typing waits for a pause before searching; every other filter applies at once.
  useEffect(() => {
    const searchOnly = { ...filters, search: applied.search };
    const delay = JSON.stringify(searchOnly) === JSON.stringify(applied) ? SEARCH_DELAY_MS : 0;
    const timer = setTimeout(() => setApplied(filters), delay);
    return () => clearTimeout(timer);
  }, [filters, applied]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt re-runs the fetch on Retry
  useEffect(() => {
    const query = historyQuery(applied, new Date());
    if (!query) {
      setRows([]);
      setCursor(null);
      setLoading(false);
      return;
    }
    let live = true;
    setLoading(true);
    setError(null);
    api.history(query).then(
      (page) => {
        if (!live) return;
        setRows(page.items.map(toRow));
        setCursor(page.next_cursor);
        setLoading(false);
      },
      (err) => {
        if (!live) return;
        setError(messageOf(err));
        setLoading(false);
      },
    );
    return () => {
      live = false;
    };
  }, [applied, attempt]);

  const loadMore = async () => {
    const query = historyQuery(applied, new Date());
    if (!query || !cursor) return;
    setMore(true);
    try {
      const page = await api.history({ ...query, cursor });
      setRows((current) => [...current, ...page.items.map(toRow)]);
      setCursor(page.next_cursor);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setMore(false);
    }
  };

  const favourite = async (row: HistoryRow) => {
    const flip = (on: boolean) =>
      setRows((current) => current.map((r) => (r.id === row.id ? { ...r, favourite: on } : r)));
    flip(!row.favourite);
    try {
      await api.favourite(row.id, !row.favourite);
      onFavourite?.();
    } catch (err) {
      flip(row.favourite);
      setError(messageOf(err));
    }
  };

  return (
    <Shell>
      <div className="mx-auto grid max-w-[1200px] gap-4 px-8 py-6">
        <h1 className="text-title font-semibold">History</h1>
        {error && rows.length === 0 ? (
          <EmptyState
            title="History couldn't be loaded"
            description={error}
            action={{ label: "Try again", onClick: () => setAttempt((n) => n + 1) }}
          />
        ) : (
          <>
            {error && (
              <p role="alert" className="text-dense text-destructive">
                {error}
              </p>
            )}
            <HistoryTable
              rows={rows}
              loading={loading}
              filters={filters}
              onFiltersChange={setFilters}
              onOpen={(row) => navigate(paths.thread(row.id))}
              onFavourite={favourite}
              onStart={() => navigate(paths.new)}
            />
            {cursor && !loading && (
              <Button
                variant="secondary"
                className="justify-self-center"
                disabled={more}
                onClick={loadMore}
              >
                {more ? "Loading…" : "Load more"}
              </Button>
            )}
          </>
        )}
      </div>
    </Shell>
  );
}
