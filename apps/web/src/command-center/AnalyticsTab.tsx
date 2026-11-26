import { Button, Checkbox, Field, Input, NativeSelect } from "@legallabs/ui";
import { type FormEvent, useState } from "react";
import { messageOf, Panel, useLoad, when } from "../admin/load.js";
import { type Bucket, centerApi, type Range, type UserRow } from "./api.js";
import { Freshness } from "./DataState.js";
import { Card, Columns, Nothing, Table } from "./parts.js";

export function AnalyticsTab({ range }: { range: Range }) {
  const [granularity, setGranularity] = useState<"day" | "week">("day");
  const [role, setRole] = useState("");
  const [area, setArea] = useState("");
  const roles = useLoad(centerApi.roles, []);
  const filters = { ...range, roles: role || undefined, practice_areas: area || undefined };
  const state = useLoad(
    () => centerApi.report({ ...filters, granularity }),
    [range.from, range.to, granularity, role, area],
  );
  // Choosing one practice area would otherwise leave it as the only choice.
  const all = useLoad(() => centerApi.report({ ...range }), [range.from, range.to]);
  const csv = (chart: string) => centerApi.csvUrl(chart, { ...filters, granularity });

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end gap-3">
        {roles.data && (
          <Field label="Role">
            {(props) => (
              <NativeSelect {...props} value={role} onChange={(e) => setRole(e.target.value)}>
                <option value="">All roles</option>
                {roles.data?.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
        )}
        <Field label="Practice area">
          {(props) => (
            <NativeSelect {...props} value={area} onChange={(e) => setArea(e.target.value)}>
              <option value="">All practice areas</option>
              {all.data?.topPracticeAreas.map((b) => (
                <option key={b.label} value={b.label}>
                  {b.label}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
      </div>
      <Panel state={state}>
        {(data) => {
          const series = data.queriesOverTime.series;
          const total = series.reduce((n, s) => n + s.with_sources + s.without_sources, 0);
          return (
            <>
              <Freshness
                dataAsOf={data.dataAsOf}
                message={data.message}
                onRefreshed={state.reload}
              />
              {data.state === "ready" && (
                <div className="grid gap-4 xl:grid-cols-2">
                  <div className="min-w-0 xl:col-span-2">
                    <Card title="Queries over time" csv={csv("queries_over_time")}>
                      <Field label="Group by">
                        {(props) => (
                          <NativeSelect
                            {...props}
                            className="w-40"
                            value={granularity}
                            onChange={(e) => setGranularity(e.target.value as "day" | "week")}
                          >
                            <option value="day">Day</option>
                            <option value="week">Week</option>
                          </NativeSelect>
                        )}
                      </Field>
                      {data.filtersNote && (
                        <p className="text-dense text-fg-muted">{data.filtersNote}</p>
                      )}
                      {total === 0 ? (
                        <Nothing>No queries recorded in this range.</Nothing>
                      ) : (
                        <div className="grid gap-4 md:grid-cols-2">
                          {(
                            [
                              ["with_sources", "With sources"],
                              ["without_sources", "Without sources"],
                            ] as const
                          ).map(([key, label]) => (
                            <div key={key} className="min-w-0">
                              <h3 className="text-ui font-medium">{label}</h3>
                              <Columns
                                label={`Queries ${label.toLowerCase()}`}
                                unit="queries"
                                points={series.map((s) => ({ key: s.bucket, value: s[key] }))}
                              />
                            </div>
                          ))}
                        </div>
                      )}
                    </Card>
                  </div>
                  <Buckets
                    title="Top practice areas"
                    head="Practice area"
                    rows={data.topPracticeAreas}
                    csv={csv("practice_areas")}
                  />
                  <Buckets
                    title="Top job titles"
                    head="Job title"
                    rows={data.topJobTitles}
                    csv={csv("job_titles")}
                  />
                </div>
              )}
            </>
          );
        }}
      </Panel>
      <Users range={range} role={role} area={area} />
      <Exports range={range} />
    </div>
  );
}

function Buckets({
  title,
  head,
  rows,
  csv,
}: {
  title: string;
  head: string;
  rows: Bucket[];
  csv: string;
}) {
  return (
    <Card title={title} csv={csv}>
      {rows.length === 0 ? (
        <Nothing>No queries recorded in this range.</Nothing>
      ) : (
        <>
          {rows.every((r) => r.label === "Unknown") && (
            <Nothing>No one's profile records this yet, so everyone shows as Unknown.</Nothing>
          )}
          <Table
            label={title}
            head={[head, "Active users", "Queries"]}
            rows={rows.map((r) => ({ key: r.label, cells: [r.label, r.users, r.queries] }))}
          />
        </>
      )}
    </Card>
  );
}

const COLUMNS: { key: Exclude<keyof UserRow, "user_id" | "email">; label: string }[] = [
  { key: "name", label: "User" },
  { key: "role", label: "Role" },
  { key: "active_days", label: "Active days" },
  { key: "total_activity", label: "Total activity" },
  { key: "threads", label: "Threads" },
  { key: "follow_ups", label: "Follow-ups" },
  { key: "agent_runs", label: "Agent runs" },
  { key: "playbook_runs", label: "Playbook runs" },
  { key: "rt_columns", label: "Table columns" },
  { key: "word", label: "Word" },
  { key: "last_active", label: "Last active" },
];
const PAGE_SIZE = 25;

function Users({ range, role, area }: { range: Range; role: string; area: string }) {
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" }>({
    key: "active_days",
    dir: "desc",
  });
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const params = {
    ...range,
    roles: role || undefined,
    practice_areas: area || undefined,
    sort: sort.key,
    dir: sort.dir,
    q: q.trim() || undefined,
  };
  const state = useLoad(
    () => centerApi.users({ ...params, page, page_size: PAGE_SIZE }),
    [range.from, range.to, role, area, sort.key, sort.dir, q, page],
  );
  return (
    <Card title="Users by activity" csv={centerApi.csvUrl("users", params)}>
      <Field label="Search name or email" className="max-w-xs">
        {(props) => (
          <Input
            {...props}
            type="search"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPage(1);
            }}
          />
        )}
      </Field>
      <p className="text-dense text-fg-muted">Outlook use is not recorded, so it has no column.</p>
      <Panel state={state}>
        {(data) =>
          data.total === 0 ? (
            <Nothing>No one has recorded activity that matches.</Nothing>
          ) : (
            <>
              <div className="overflow-auto">
                <table
                  aria-label="Users by activity"
                  className="w-full border-collapse text-dense tabular-nums"
                >
                  <thead>
                    <tr>
                      {COLUMNS.map((c) => (
                        <th
                          key={c.key}
                          scope="col"
                          aria-sort={
                            sort.key !== c.key
                              ? undefined
                              : sort.dir === "asc"
                                ? "ascending"
                                : "descending"
                          }
                          className="h-row border-b border-border px-2 text-left font-medium text-fg-muted"
                        >
                          <button
                            type="button"
                            className="rounded-sm whitespace-nowrap hover:text-fg"
                            onClick={() => {
                              setSort({
                                key: c.key,
                                dir: sort.key === c.key && sort.dir === "desc" ? "asc" : "desc",
                              });
                              setPage(1);
                            }}
                          >
                            {c.label}
                            {sort.key === c.key ? (sort.dir === "asc" ? " ↑" : " ↓") : ""}
                          </button>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((u) => (
                      <tr key={u.user_id} className="h-row border-b border-border">
                        {COLUMNS.map((c) => (
                          <td key={c.key} className="px-2 whitespace-nowrap">
                            {c.key === "name" ? (
                              <>
                                {u.name || u.email}
                                {u.name && <span className="text-fg-muted"> {u.email}</span>}
                              </>
                            ) : c.key === "last_active" ? (
                              (u.last_active ?? "Never")
                            ) : (
                              u[c.key]
                            )}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-dense text-fg-muted">
                  Page {data.page} of {Math.max(1, Math.ceil(data.total / data.page_size))},{" "}
                  {data.total} {data.total === 1 ? "user" : "users"}
                </p>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => setPage(page - 1)}
                >
                  Previous
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={page * data.page_size >= data.total}
                  onClick={() => setPage(page + 1)}
                >
                  Next
                </Button>
              </div>
            </>
          )
        }
      </Panel>
    </Card>
  );
}

function Exports({ range }: { range: Range }) {
  const state = useLoad(centerApi.exports, []);
  const [former, setFormer] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    centerApi
      .createExport({ ...range, include_former: former })
      .then(state.reload, (e: unknown) => {
        setError(messageOf(e));
        state.reload();
      })
      .finally(() => setBusy(false));
  };
  return (
    <Card title="Event exports">
      <form onSubmit={submit} className="flex flex-wrap items-center gap-3">
        <label htmlFor="export-former" className="flex items-center gap-2 text-ui">
          <Checkbox
            id="export-former"
            checked={former}
            onCheckedChange={(v) => setFormer(v === true)}
          />
          Include former members
        </label>
        <Button type="submit" size="sm" disabled={busy}>
          {busy ? "Exporting…" : `Export events, ${range.from} to ${range.to}`}
        </Button>
      </form>
      <p className="text-dense text-fg-muted">
        One row per recorded event, with no prompt text or file names. Files are kept for 7 days. No
        email is sent; download them here.
      </p>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <Panel state={state}>
        {(jobs) =>
          jobs.length === 0 ? (
            <Nothing>No exports yet.</Nothing>
          ) : (
            <Table
              label="Event exports"
              head={["Requested", "Range", "Events", "Status", ""]}
              rows={jobs.map((job) => ({
                key: job.id,
                cells: [
                  when(job.created_at),
                  `${job.params.from ?? ""} to ${job.params.to ?? ""}`,
                  job.row_count ?? "",
                  job.status === "failed" ? "Failed" : job.status === "done" ? "Ready" : "Working",
                  job.status === "done" ? (
                    <a
                      key="file"
                      className="text-accent underline"
                      href={centerApi.exportUrl(job.id)}
                      download
                    >
                      Download
                    </a>
                  ) : null,
                ],
              }))}
            />
          )
        }
      </Panel>
    </Card>
  );
}
