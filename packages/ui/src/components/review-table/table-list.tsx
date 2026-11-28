import { Plus, Star, Table2 } from "lucide-react";
import { Button } from "../button.js";
import { DataTable, type TableColumn } from "../data-table.js";
import { EmptyState } from "../empty-state.js";

export interface TableSummary {
  id: string;
  name: string;
  source_kind: "vault" | "uploads";
  starred: boolean;
  updated_at: string;
  stats: { rows: number; columns: number };
}

/** The Review tables page: every table, a Starred filter and Create (RVT-001, RVT-010). */
export function TableList({
  tables,
  loading = false,
  starredOnly,
  onStarredOnlyChange,
  onStar,
  onOpen,
  onCreate,
}: {
  tables: readonly TableSummary[];
  loading?: boolean;
  starredOnly: boolean;
  onStarredOnlyChange: (starredOnly: boolean) => void;
  onStar: (table: TableSummary, starred: boolean) => void;
  onOpen: (table: TableSummary) => void;
  /** Left out where tables can only be read. */
  onCreate?: () => void;
}) {
  const shown = starredOnly ? tables.filter((t) => t.starred) : tables;
  const columns: TableColumn<TableSummary>[] = [
    {
      id: "star",
      header: "Star",
      width: 56,
      cell: (t) => (
        <Button
          variant="quiet"
          size="icon"
          aria-pressed={t.starred}
          aria-label={t.starred ? `Unstar ${t.name}` : `Star ${t.name}`}
          onClick={(event) => {
            event.stopPropagation();
            onStar(t, !t.starred);
          }}
        >
          <Star
            aria-hidden
            fill={t.starred ? "currentColor" : "none"}
            className={t.starred ? "text-warning" : ""}
          />
        </Button>
      ),
    },
    {
      id: "name",
      header: "Name",
      sortValue: (t) => t.name.toLowerCase(),
      cell: (t) => (
        <Button
          variant="quiet"
          size="sm"
          className="h-auto max-w-full justify-start truncate px-0 text-left font-medium hover:underline"
          onClick={() => onOpen(t)}
        >
          {t.name}
        </Button>
      ),
    },
    {
      id: "source",
      header: "Source",
      width: 120,
      cell: (t) => (t.source_kind === "vault" ? "Vault" : "Uploaded files"),
    },
    {
      id: "rows",
      header: "Rows",
      align: "end",
      width: 90,
      sortValue: (t) => t.stats.rows,
      cell: (t) => t.stats.rows.toLocaleString(),
    },
    {
      id: "columns",
      header: "Columns",
      align: "end",
      width: 100,
      sortValue: (t) => t.stats.columns,
      cell: (t) => t.stats.columns.toLocaleString(),
    },
    {
      id: "updated",
      header: "Updated",
      width: 180,
      sortValue: (t) => t.updated_at,
      cell: (t) => <time dateTime={t.updated_at}>{new Date(t.updated_at).toLocaleString()}</time>,
    },
  ];
  return (
    <section aria-labelledby="review-tables-title" className="grid gap-4">
      <header className="flex flex-wrap items-center gap-2">
        <h1 id="review-tables-title" className="flex-1 text-title font-semibold">
          Review tables
        </h1>
        <Button
          variant="secondary"
          aria-pressed={starredOnly}
          onClick={() => onStarredOnlyChange(!starredOnly)}
        >
          <Star aria-hidden fill={starredOnly ? "currentColor" : "none"} />
          Starred
        </Button>
        {onCreate && (
          <Button onClick={onCreate}>
            <Plus aria-hidden />
            Create
          </Button>
        )}
      </header>
      <DataTable
        label="Review tables"
        columns={columns}
        rows={shown}
        getRowId={(t) => t.id}
        onActivate={onOpen}
        loading={loading}
        empty={
          starredOnly ? (
            <EmptyState
              icon={Star}
              title="No starred tables"
              description="Star a table to keep it here."
              action={{ label: "Show all tables", onClick: () => onStarredOnlyChange(false) }}
            />
          ) : (
            <EmptyState
              icon={Table2}
              title="No review tables yet"
              description="A review table asks the same questions of every document, one row each."
              action={
                onCreate
                  ? { label: "Create a table", onClick: onCreate }
                  : { label: "Show all tables", onClick: () => onStarredOnlyChange(false) }
              }
            />
          )
        }
      />
    </section>
  );
}
