import {
  HORIZON_SOURCES,
  type HorizonItem,
  type HorizonRelevance,
  type HorizonScan,
} from "@legallabs/contracts";
import {
  Button,
  Checkbox,
  ConfirmDialog,
  DataTable,
  EmptyState,
  Field,
  Input,
  NativeSelect,
  Skeleton,
  StatusText,
  type TableColumn,
  Tabs,
  TabsList,
  TabsTrigger,
} from "@legallabs/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { messageOf } from "../api.js";
import { latestOnly } from "../latest.js";
import { formatDate } from "../vaults/shared.js";
import { horizonApi, type ItemFilter } from "./api.js";
import { ItemActions } from "./ItemActions.js";
import { goHorizon } from "./route.js";

const RANK: Record<HorizonRelevance, number> = { low: 0, medium: 1, high: 2 };
const RELEVANCE = { high: "High", medium: "Medium", low: "Low" } as const;
const TYPES = [
  ["rule", "Rule"],
  ["proposed_rule", "Proposed rule"],
  ["notice", "Notice"],
  ["presidential_document", "Presidential document"],
  ["regulation", "Regulation"],
  ["act", "Act"],
  ["statutory_instrument", "Statutory instrument"],
  ["other", "Other"],
] as const;

export const typeName = (type: string) => TYPES.find(([id]) => id === type)?.[1] ?? type;
export const sourceName = (id: string) => HORIZON_SOURCES.find((s) => s.id === id)?.name ?? id;

const NO_FILTER: ItemFilter = {
  tab: "all",
  relevance: "",
  type: "",
  source: "",
  jurisdiction: "",
  topic: "",
  industry: "",
  q: "",
};

const TABS: [ItemFilter["tab"], string][] = [
  ["all", "All"],
  ["unread", "Unread"],
  ["starred", "Starred"],
  ["archived", "Archived"],
];

/** Only an https address is ever offered as a link. */
export const safeLink = (url: string) => (url.startsWith("https://") ? url : null);

function Select({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly (readonly [string, string])[];
  onChange: (value: string) => void;
}) {
  return (
    <Field label={label}>
      {(props) => (
        <NativeSelect {...props} value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">Any</option>
          {options.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </NativeSelect>
      )}
    </Field>
  );
}

/** One scan's dashboard: what it found, filtered, and what the reader has done with it. */
export function ScanPage({ scanId }: { scanId: string }) {
  const [scan, setScan] = useState<HorizonScan | null>(null);
  const [filter, setFilter] = useState(NO_FILTER);
  const [items, setItems] = useState<HorizonItem[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [below, setBelow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fetchPage = useRef(latestOnly(horizonApi.items)).current;

  const refreshScan = useCallback(
    () => horizonApi.scan(scanId).then(setScan, (err) => setError(messageOf(err))),
    [scanId],
  );

  const load = useCallback(
    async (query: ItemFilter, after?: string) => {
      setError(null);
      try {
        const result = await fetchPage(scanId, query, after);
        if (!result.current) return;
        const page = result.value;
        setItems((before) => (after ? [...(before ?? []), ...page.items] : page.items));
        setCursor(page.next_cursor);
      } catch (err) {
        setItems([]);
        setCursor(null);
        setError(messageOf(err));
      }
    },
    [fetchPage, scanId],
  );

  useEffect(() => void refreshScan(), [refreshScan]);
  useEffect(() => {
    setItems(null);
    setPicked(new Set());
    setOpen(null);
    void load(filter);
  }, [filter, load]);

  const set = (key: keyof ItemFilter) => (value: string) =>
    setFilter((f) => ({ ...f, [key]: value }));

  const patch = (ids: ReadonlySet<string>, state: Partial<HorizonItem["state"]>) =>
    setItems((list) =>
      (list ?? []).map((i) => (ids.has(i.id) ? { ...i, state: { ...i.state, ...state } } : i)),
    );

  const change = async (item: HorizonItem, state: Partial<HorizonItem["state"]>) => {
    try {
      await horizonApi.setState(item.id, state);
      patch(new Set([item.id]), state);
      await refreshScan();
    } catch (err) {
      setError(messageOf(err));
    }
  };

  const show = (item: HorizonItem) => {
    setOpen(item.id);
    if (!item.state.read) void change(item, { read: true });
  };

  const bulk = async (action: "archive" | "unarchive" | "star" | "read") => {
    try {
      await horizonApi.bulk([...picked], action);
      setPicked(new Set());
      await Promise.all([load(filter), refreshScan()]);
    } catch (err) {
      setError(messageOf(err));
    }
  };

  const remove = async () => {
    try {
      await horizonApi.remove(scanId);
      goHorizon({ page: "list" });
    } catch (err) {
      setError(messageOf(err));
    }
  };

  if (!scan) return error ? <p role="alert">{error}</p> : <Skeleton className="h-40" />;

  const floor = RANK[scan.relevance_floor];
  // Starred items stay in sight whatever their grade.
  const under = (i: HorizonItem) => RANK[i.relevance] < floor && !i.state.starred;
  const hidden = (items ?? []).filter(under).length;
  const rows = (items ?? []).filter((i) => below || !under(i));
  const opened = rows.find((i) => i.id === open);

  const columns: TableColumn<HorizonItem>[] = [
    {
      id: "pick",
      header: "Select",
      width: 56,
      cell: (item) => (
        <Checkbox
          aria-label={`Select ${item.development}`}
          checked={picked.has(item.id)}
          onCheckedChange={(on) =>
            setPicked((before) => {
              const next = new Set(before);
              if (on === true) next.add(item.id);
              else next.delete(item.id);
              return next;
            })
          }
        />
      ),
    },
    {
      id: "development",
      header: "Development",
      sortValue: (i) => i.development.toLowerCase(),
      cell: (item) => (
        <button
          type="button"
          className={`line-clamp-1 text-left underline ${item.state.read ? "" : "font-semibold"}`}
          title={item.development}
          onClick={() => show(item)}
        >
          {item.development}
        </button>
      ),
    },
    {
      id: "relevance",
      header: "Relevance",
      sortValue: (i) => RANK[i.relevance],
      cell: (i) =>
        i.relevance === "high" ? (
          <StatusText tone="flagged">{RELEVANCE.high}</StatusText>
        ) : (
          RELEVANCE[i.relevance]
        ),
    },
    {
      id: "type",
      header: "Type",
      sortValue: (i) => i.type,
      cell: (i) => typeName(i.type),
    },
    { id: "industries", header: "Industries", cell: (i) => i.industries.join(", ") },
    { id: "topics", header: "Topics", cell: (i) => i.topics.join(", ") },
    { id: "sources", header: "Sources", cell: (i) => i.sources.map(sourceName).join(", ") },
    { id: "jurisdictions", header: "Jurisdictions", cell: (i) => i.jurisdictions.join(", ") },
    {
      id: "published",
      header: "Published",
      sortValue: (i) => i.published_at,
      cell: (i) => formatDate(i.published_at),
    },
  ];

  const filtered = Object.entries(filter).some(([key, value]) => key !== "tab" && value);

  return (
    <div className="grid min-w-0 content-start gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-title font-semibold">{scan.name}</h1>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => goHorizon({ page: "edit", scanId })}>
            Change scan
          </Button>
          <ConfirmDialog
            trigger={<Button variant="secondary">Delete scan</Button>}
            title="Delete this scan?"
            description="The scan and everything it found are deleted. This can't be undone."
            confirmLabel="Delete scan"
            destructive
            onConfirm={() => void remove()}
          />
        </div>
      </div>
      {scan.stopped && (
        <p role="status">
          Refreshing stopped because you could no longer run this scan. Change and save it to start
          again.
        </p>
      )}
      {scan.health === "degraded" && (
        <p role="status">
          {`Not answering: ${scan.failing_sources.map(sourceName).join(", ")}. Other sources are still checked.`}
        </p>
      )}
      <Tabs value={filter.tab} onValueChange={set("tab")}>
        <TabsList aria-label="Items">
          {TABS.map(([id, name]) => (
            <TabsTrigger key={id} value={id}>
              {name}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Search">
          {(props) => (
            <Input
              {...props}
              type="search"
              value={filter.q}
              maxLength={200}
              onChange={(e) => set("q")(e.target.value)}
            />
          )}
        </Field>
        <Select
          label="Relevance"
          value={filter.relevance}
          options={Object.entries(RELEVANCE)}
          onChange={set("relevance")}
        />
        <Select label="Type" value={filter.type} options={TYPES} onChange={set("type")} />
        <Select
          label="Source"
          value={filter.source}
          options={scan.sources.map((s) => [s, sourceName(s)] as const)}
          onChange={set("source")}
        />
        <Select
          label="Jurisdiction"
          value={filter.jurisdiction}
          options={[
            ["US", "US"],
            ["UK", "UK"],
          ]}
          onChange={set("jurisdiction")}
        />
        <Select
          label="Topic"
          value={filter.topic}
          options={scan.topics.map((t) => [t, t] as const)}
          onChange={set("topic")}
        />
        <Select
          label="Industry"
          value={filter.industry}
          options={scan.industries.map((t) => [t, t] as const)}
          onChange={set("industry")}
        />
      </div>
      {picked.size > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span>{`${picked.size} selected`}</span>
          <Button size="sm" variant="secondary" onClick={() => void bulk("star")}>
            Star
          </Button>
          <Button size="sm" variant="secondary" onClick={() => void bulk("read")}>
            Mark read
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void bulk(filter.tab === "archived" ? "unarchive" : "archive")}
          >
            {filter.tab === "archived" ? "Unarchive" : "Archive"}
          </Button>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
      {opened && (
        <section aria-label="Item" className="grid gap-2 rounded-md border border-border p-3">
          <h2 className="font-semibold">{opened.development}</h2>
          <p>{opened.explanation}</p>
          {opened.summary && <p className="text-fg-muted">{opened.summary}</p>}
          <ItemActions key={opened.id} itemId={opened.id} />
          <div className="flex flex-wrap items-center gap-2">
            {safeLink(opened.source_url) && (
              <a
                className="underline"
                href={opened.source_url}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open at the source
              </a>
            )}
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void change(opened, { starred: !opened.state.starred })}
            >
              {opened.state.starred ? "Remove star" : "Star"}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void change(opened, { archived: !opened.state.archived })}
            >
              {opened.state.archived ? "Unarchive" : "Archive"}
            </Button>
            <Button size="sm" variant="quiet" onClick={() => setOpen(null)}>
              Close
            </Button>
          </div>
        </section>
      )}
      <DataTable
        label="Developments"
        columns={columns}
        rows={rows}
        getRowId={(i) => i.id}
        onActivate={show}
        loading={items === null}
        empty={
          <EmptyState
            title={filtered ? "Nothing matches" : "Nothing here yet"}
            description={
              filtered
                ? "Try fewer filters."
                : "New developments show here after the scan's next refresh."
            }
            action={
              filtered
                ? {
                    label: "Clear filters",
                    onClick: () => setFilter((f) => ({ ...NO_FILTER, tab: f.tab })),
                  }
                : { label: "Check again", onClick: () => void load(filter) }
            }
          />
        }
      />
      {hidden > 0 && (
        <Button variant="quiet" size="sm" onClick={() => setBelow((b) => !b)}>
          {below
            ? "Hide items below your relevance floor"
            : `Show ${hidden} below your relevance floor`}
        </Button>
      )}
      {cursor && (
        <Button variant="secondary" onClick={() => void load(filter, cursor)}>
          Load more
        </Button>
      )}
    </div>
  );
}
