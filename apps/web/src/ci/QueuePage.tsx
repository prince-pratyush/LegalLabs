import {
  type CiAgent,
  type CiDashboard,
  type CiReview,
  CiReviewStatus,
} from "@legallabs/contracts";
import {
  Button,
  DataTable,
  EmptyState,
  Field,
  Input,
  NativeSelect,
  type TableColumn,
  Tabs,
  TabsList,
  TabsTrigger,
} from "@legallabs/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, messageOf } from "../api.js";
import { latestOnly } from "../latest.js";
import { formatDate } from "../vaults/shared.js";
import { ciApi, type QueueFilter } from "./api.js";
import { ciHash, goCi } from "./route.js";
import { REVIEW_STATUS, ReviewStatusText } from "./shared.js";

type Tab = "mine" | "all";
interface Filters {
  status: string;
  agentId: string;
  assigneeId: string;
  counterparty: string;
  from: string;
  to: string;
}
const NO_FILTERS: Filters = {
  status: "",
  agentId: "",
  assigneeId: "",
  counterparty: "",
  from: "",
  to: "",
};

/** Midnight here at the start of a picked day, or of the day after it. */
function midnight(day: string, after = 0): string {
  const [y = 0, m = 1, d = 1] = day.split("-").map(Number);
  return new Date(y, m - 1, d + after).toISOString();
}

const toQuery = (tab: Tab, f: Filters): QueueFilter => ({
  status: f.status,
  agentId: f.agentId,
  assigneeId: tab === "mine" ? "me" : f.assigneeId,
  counterparty: f.counterparty.trim(),
  ...(f.from ? { from: midnight(f.from) } : {}),
  ...(f.to ? { to: midnight(f.to, 1) } : {}),
});

// When each person last opened the queue is only a convenience, so the browser keeps it.
const seenKey = (userId: string) => `legallabs.ci.seen.${userId}`;
function lastSeen(userId: string): string | null {
  try {
    return localStorage.getItem(seenKey(userId));
  } catch {
    return null;
  }
}
function remember(userId: string, at: string) {
  try {
    localStorage.setItem(seenKey(userId), at);
  } catch {
    // Storage blocked: the next visit shows no banner.
  }
}

function Counter({ label, value }: { label: string; value: number | undefined }) {
  return (
    <section aria-label={label} className="grid gap-1 rounded-md border border-border p-3">
      <span className="text-caption text-fg-muted">{label}</span>
      <span className="text-title font-semibold tabular-nums">{value ?? "–"}</span>
    </section>
  );
}

const columns: TableColumn<CiReview>[] = [
  {
    id: "document",
    header: "Reviewed doc",
    sortValue: (r) => r.document_name.toLowerCase(),
    cell: (r) => (
      <a className="underline" href={ciHash({ page: "review", reviewId: r.id })}>
        {r.document_name}
      </a>
    ),
  },
  {
    id: "status",
    header: "Status",
    sortValue: (r) => REVIEW_STATUS[r.status].label,
    cell: (r) => <ReviewStatusText status={r.status} />,
  },
  {
    id: "summary",
    header: "Summary",
    sortValue: (r) => r.summary ?? "",
    cell: (r) => (
      <span className="line-clamp-1" title={r.summary ?? undefined}>
        {r.summary}
      </span>
    ),
  },
  {
    id: "counterparty",
    header: "Counterparty",
    sortValue: (r) => r.counterparty?.toLowerCase() ?? "",
    cell: (r) => r.counterparty,
  },
  {
    id: "updated",
    header: "Last updated",
    sortValue: (r) => r.updated_at,
    cell: (r) => formatDate(r.updated_at),
  },
  {
    id: "assignee",
    header: "Assignee",
    sortValue: (r) => r.assignee_name?.toLowerCase() ?? "",
    cell: (r) => r.assignee_name,
  },
];

/** The queue of reviewed contracts: counters, then mine or all of them, filtered. */
export function QueuePage() {
  const [counts, setCounts] = useState<CiDashboard | null>(null);
  const [tab, setTab] = useState<Tab>("mine");
  const [filters, setFilters] = useState(NO_FILTERS);
  const [rows, setRows] = useState<CiReview[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [agents, setAgents] = useState<CiAgent[]>([]);
  // Names seen in any page, so choosing a filter doesn't empty its own list of choices.
  const [seen, setSeen] = useState({
    agents: new Map<string, string>(),
    people: new Map<string, string>(),
  });
  const fetchPage = useRef(latestOnly(ciApi.reviews)).current;

  useEffect(() => {
    api.session().then(
      ({ user_id }) =>
        ciApi.dashboard(lastSeen(user_id)).then(
          (d) => {
            setCounts(d);
            remember(user_id, d.as_of);
          },
          () => undefined,
        ),
      () => undefined,
    );
    ciApi.agents().then(setAgents, () => undefined);
  }, []);

  const load = useCallback(
    async (query: QueueFilter, after?: string) => {
      setError(null);
      try {
        const result = await fetchPage(query, after);
        if (!result.current) return;
        const { reviews, next_cursor } = result.value;
        setRows((before) => (after ? [...(before ?? []), ...reviews] : reviews));
        setCursor(next_cursor);
        setSeen((known) => {
          const next = { agents: new Map(known.agents), people: new Map(known.people) };
          for (const r of reviews) {
            next.agents.set(r.agent_id, r.agent_name);
            if (r.assignee_id) next.people.set(r.assignee_id, r.assignee_name ?? "Unnamed");
          }
          return next;
        });
      } catch (err) {
        setRows([]);
        setCursor(null);
        setError(messageOf(err));
      }
    },
    [fetchPage],
  );

  useEffect(() => {
    setRows(null);
    load(toQuery(tab, filters));
  }, [tab, filters, load]);

  const set = (key: keyof Filters) => (e: { target: { value: string } }) =>
    setFilters((f) => ({ ...f, [key]: e.target.value }));
  const filtered = Object.entries(filters).some(
    ([key, value]) => value && !(tab === "mine" && key === "assigneeId"),
  );
  const agentNames = new Map([...seen.agents, ...agents.map((a) => [a.id, a.name] as const)]);

  const empty = filtered ? (
    <EmptyState
      title="No reviews match"
      description="Try a wider date range or fewer filters."
      action={{ label: "Clear filters", onClick: () => setFilters(NO_FILTERS) }}
    />
  ) : (
    <EmptyState
      title={tab === "mine" ? "Nothing is assigned to you" : "No contracts yet"}
      description="Contracts show here once a review agent has been given them."
      action={{
        label: "Submit a contract",
        onClick: () => goCi({ page: "submit", agentId: null }),
      }}
    />
  );

  return (
    <div className="grid content-start gap-4">
      <h1 className="text-title font-semibold">Contract queue</h1>
      {counts && counts.since_last_visit > 0 && (
        <p role="status" className="rounded-md border border-border bg-bg-subtle px-3 py-2">
          Reviewed {counts.since_last_visit}{" "}
          {counts.since_last_visit === 1 ? "contract" : "contracts"} since your last visit
        </p>
      )}
      <div className="grid max-w-md grid-cols-2 gap-3">
        <Counter label="Ready to review" value={counts?.ready_to_review} />
        <Counter label="Assigned to you" value={counts?.assigned_to_me} />
      </div>
      <Tabs value={tab} onValueChange={(next) => setTab(next as Tab)}>
        <TabsList aria-label="Which reviews">
          <TabsTrigger value="mine">My reviews</TabsTrigger>
          <TabsTrigger value="all">All</TabsTrigger>
        </TabsList>
      </Tabs>
      <div className="flex flex-wrap gap-3">
        <Field label="Agent">
          {(props) => (
            <NativeSelect {...props} value={filters.agentId} onChange={set("agentId")}>
              <option value="">Any agent</option>
              {[...agentNames].map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
        <Field label="Status">
          {(props) => (
            <NativeSelect {...props} value={filters.status} onChange={set("status")}>
              <option value="">Any status</option>
              {CiReviewStatus.options.map((status) => (
                <option key={status} value={status}>
                  {REVIEW_STATUS[status].label}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
        {tab === "all" && (
          <Field label="Assignee">
            {(props) => (
              <NativeSelect {...props} value={filters.assigneeId} onChange={set("assigneeId")}>
                <option value="">Anyone</option>
                {[...seen.people].map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
        )}
        <Field label="Counterparty">
          {(props) => (
            <Input
              {...props}
              value={filters.counterparty}
              maxLength={200}
              onChange={set("counterparty")}
            />
          )}
        </Field>
        <Field label="Changed from">
          {(props) => <Input {...props} type="date" value={filters.from} onChange={set("from")} />}
        </Field>
        <Field label="Changed to">
          {(props) => <Input {...props} type="date" value={filters.to} onChange={set("to")} />}
        </Field>
      </div>
      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : (
        <DataTable
          label="Contract reviews"
          columns={columns}
          rows={rows ?? []}
          getRowId={(r) => r.id}
          onActivate={(r) => goCi({ page: "review", reviewId: r.id })}
          loading={rows === null}
          empty={empty}
        />
      )}
      {cursor && (
        <div className="flex items-center gap-3">
          <Button variant="secondary" onClick={() => load(toQuery(tab, filters), cursor)}>
            Load more
          </Button>
          <span className="text-caption text-fg-muted">
            Sorting covers the reviews loaded so far.
          </span>
        </div>
      )}
    </div>
  );
}
