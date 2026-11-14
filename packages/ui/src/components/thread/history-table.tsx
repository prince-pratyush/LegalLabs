import { Lock, Star } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { cn } from "../../cn.js";
import { Checkbox } from "../checkbox.js";
import { DataTable, type TableColumn } from "../data-table.js";
import { EmptyState } from "../empty-state.js";
import { Input } from "../field.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../select.js";
import { StatusText, type Tone } from "../status.js";
import { formatCost, isLocalModel } from "./format.js";
import {
  type DatePreset,
  type DocBucket,
  filterRows,
  type GroupBy,
  groupRows,
  type HistoryFilters,
  type HistoryRow,
  type HistoryStatus,
  type HistoryType,
  NO_FILTERS,
  TYPE_LABELS,
} from "./history.js";

const STATUS: Record<HistoryStatus, { tone: Tone; label: string }> = {
  done: { tone: "verified", label: "Done" },
  running: { tone: "running", label: "Running" },
  needs_input: { tone: "warning", label: "Needs input" },
  failed: { tone: "failed", label: "Failed" },
};

const when = new Intl.DateTimeFormat("en-AU", { dateStyle: "medium", timeStyle: "short" });

function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly (readonly [T, string])[];
  onChange: (value: T) => void;
}) {
  return (
    <Select value={value} onValueChange={(next) => onChange(next as T)}>
      <SelectTrigger aria-label={label} className="h-8 w-36">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map(([id, text]) => (
          <SelectItem key={id} value={id}>
            {text}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

const TYPES: readonly (readonly [HistoryType | "any", string])[] = [
  ["any", "Any type"],
  ...(Object.entries(TYPE_LABELS) as [HistoryType, string][]),
];
const DATES: readonly (readonly [DatePreset, string])[] = [
  ["any", "Any time"],
  ["7d", "Last 7 days"],
  ["30d", "Last 30 days"],
  ["90d", "Last 90 days"],
];
const DOCS: readonly (readonly [DocBucket | "any", string])[] = [
  ["any", "Any files"],
  ["0", "No files"],
  ["1", "1 file"],
  ["2-10", "2–10 files"],
  ["11-100", "11–100 files"],
  [">100", "Over 100 files"],
];
const GROUPS: readonly (readonly [GroupBy, string])[] = [
  ["none", "No grouping"],
  ["day", "By day"],
  ["week", "By week"],
  ["month", "By month"],
  ["type", "By type"],
];

/** Every past thread and run, searchable, with model and cost on each row. */
export function HistoryTable({
  rows,
  onOpen,
  onFavourite,
  onStart,
  loading = false,
  now = new Date(),
  className,
}: {
  rows: readonly HistoryRow[];
  onOpen: (row: HistoryRow) => void;
  onFavourite: (row: HistoryRow) => void;
  /** The empty state's action, so a new workspace isn't a dead end. */
  onStart: () => void;
  loading?: boolean;
  now?: Date;
  className?: string;
}) {
  const [filters, setFilters] = useState<HistoryFilters>(NO_FILTERS);
  const [groupBy, setGroupBy] = useState<GroupBy>("none");
  const favouritesId = useId();
  const set = <K extends keyof HistoryFilters>(key: K, value: HistoryFilters[K]) =>
    setFilters((current) => ({ ...current, [key]: value }));

  const filtered = useMemo(() => filterRows(rows, filters, now), [rows, filters, now]);
  const groups = useMemo(() => groupRows(filtered, groupBy, now), [filtered, groupBy, now]);
  const filtering = JSON.stringify(filters) !== JSON.stringify(NO_FILTERS);

  const columns: TableColumn<HistoryRow>[] = [
    {
      id: "favourite",
      header: "Star",
      width: 56,
      cell: (row) => (
        <button
          type="button"
          aria-pressed={row.favourite}
          aria-label={row.restricted ? "Favourite" : `Favourite ${row.title}`}
          onClick={(event) => {
            event.stopPropagation();
            onFavourite(row);
          }}
          className="grid size-6 place-items-center rounded-sm text-fg-muted hover:tint-hover"
        >
          <Star
            aria-hidden
            className={cn("size-4", row.favourite && "fill-current text-warning")}
            strokeWidth={1.5}
          />
        </button>
      ),
    },
    {
      id: "title",
      header: "Title",
      sortValue: (row) => (row.restricted ? "" : row.title.toLowerCase()),
      cell: (row) =>
        row.restricted ? (
          <span className="inline-flex items-center gap-1 text-fg-muted">
            <Lock aria-hidden className="size-3.5" /> Restricted
          </span>
        ) : (
          <button
            type="button"
            onClick={() => onOpen(row)}
            className="max-w-[40ch] truncate text-left font-medium text-fg hover:underline"
          >
            {row.title}
          </button>
        ),
    },
    { id: "type", header: "Type", cell: (row) => TYPE_LABELS[row.type] },
    { id: "matter", header: "Matter", cell: (row) => row.matter ?? "—" },
    {
      id: "documents",
      header: "Files",
      align: "end",
      sortValue: (row) => row.documentCount,
      cell: (row) => row.documentCount,
    },
    { id: "model", header: "Model", cell: (row) => row.model ?? "—" },
    {
      id: "cost",
      header: "Cost",
      align: "end",
      sortValue: (row) => row.costUsd ?? 0,
      cell: (row) =>
        row.costUsd === undefined || row.costUsd === null
          ? "—"
          : formatCost(row.costUsd, isLocalModel(row.model ?? null)),
    },
    {
      id: "activity",
      header: "Last activity",
      sortValue: (row) => row.lastActivityAt,
      cell: (row) => when.format(new Date(row.lastActivityAt)),
    },
    {
      id: "status",
      header: "Status",
      cell: (row) => (
        <StatusText tone={STATUS[row.status].tone}>{STATUS[row.status].label}</StatusText>
      ),
    },
  ];

  const empty = filtering ? (
    <EmptyState
      title="No results"
      description="Nothing matches these filters."
      action={{ label: "Clear filters", onClick: () => setFilters(NO_FILTERS) }}
    />
  ) : (
    <EmptyState
      title="No threads yet"
      description="Ask a question about your documents to start one."
      action={{ label: "Start a thread", onClick: onStart }}
    />
  );

  // Restricted rows can't be opened, by keyboard or pointer.
  const activate = (row: HistoryRow) => {
    if (!row.restricted) onOpen(row);
  };

  return (
    <div className={cn("grid gap-3", className)}>
      <form
        aria-label="Filter history"
        onSubmit={(event) => event.preventDefault()}
        className="flex flex-wrap items-center gap-2"
      >
        <Input
          type="search"
          aria-label="Search history"
          placeholder="Search titles"
          value={filters.search}
          onChange={(e) => set("search", e.target.value)}
          className="w-56"
        />
        <Choice
          label="Type"
          value={filters.type}
          options={TYPES}
          onChange={(v) => set("type", v)}
        />
        <Choice
          label="Date"
          value={filters.date}
          options={DATES}
          onChange={(v) => set("date", v)}
        />
        <Choice
          label="Files"
          value={filters.docs}
          options={DOCS}
          onChange={(v) => set("docs", v)}
        />
        <Choice label="Group" value={groupBy} options={GROUPS} onChange={setGroupBy} />
        <span className="flex items-center gap-1">
          <Checkbox
            id={favouritesId}
            checked={filters.favouritesOnly}
            onCheckedChange={(checked) => set("favouritesOnly", checked === true)}
          />
          <label htmlFor={favouritesId} className="text-ui">
            Favourites only
          </label>
        </span>
      </form>
      {loading || groups.length <= 1 ? (
        <DataTable
          label="History"
          columns={columns}
          rows={groups[0]?.rows ?? []}
          getRowId={(row) => row.id}
          onActivate={activate}
          loading={loading}
          empty={empty}
        />
      ) : (
        groups.map((group) => (
          <section key={group.key} aria-label={group.key} className="grid gap-1">
            <h3 className="text-dense font-semibold text-fg-muted">
              {group.key} <span className="tabular-nums">({group.rows.length})</span>
            </h3>
            <DataTable
              label={`History, ${group.key}`}
              columns={columns}
              rows={group.rows}
              getRowId={(row) => row.id}
              onActivate={activate}
              empty={empty}
              height={320}
            />
          </section>
        ))
      )}
    </div>
  );
}
