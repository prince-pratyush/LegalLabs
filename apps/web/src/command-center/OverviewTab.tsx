import { Button, Field, NativeSelect } from "@legallabs/ui";
import { useState } from "react";
import { messageOf, Panel, useLoad } from "../admin/load.js";
import { centerApi, type Grouping, type Overview, type Range } from "./api.js";
import { Freshness } from "./DataState.js";
import { NOT_RECORDED, SURFACE_LABEL, UNRECORDED_SURFACES } from "./labels.js";
import { Bar, Card, Columns, Nothing, Table } from "./parts.js";

export function OverviewTab({ range }: { range: Range }) {
  const [grouping, setGrouping] = useState<Grouping>("day");
  const state = useLoad(
    () => centerApi.overview(range, grouping),
    [range.from, range.to, grouping],
  );
  return (
    <Panel state={state}>
      {(data) => (
        <div className="grid gap-4">
          <Freshness dataAsOf={data.dataAsOf} message={data.message} onRefreshed={state.reload} />
          <Actions actions={data.recommendedActions} onChanged={state.reload} />
          {data.state === "ready" && (
            <Charts data={data} grouping={grouping} onGrouping={setGrouping} range={range} />
          )}
        </div>
      )}
    </Panel>
  );
}

function Actions({
  actions,
  onChanged,
}: {
  actions: Overview["recommendedActions"];
  onChanged: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  if (actions.length === 0) return null;
  return (
    <Card title="Recommended actions">
      <ul className="grid gap-2">
        {actions.map((a) => (
          <li key={a.key} className="flex flex-wrap items-center justify-between gap-2">
            <span>{a.title}</span>
            <Button
              variant="quiet"
              size="sm"
              aria-label={`Dismiss for 30 days: ${a.title}`}
              onClick={() =>
                centerApi.dismiss(a.key).then(onChanged, (e: unknown) => setError(messageOf(e)))
              }
            >
              Dismiss for 30 days
            </Button>
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </Card>
  );
}

function Charts({
  data,
  grouping,
  onGrouping,
  range,
}: {
  data: Overview;
  grouping: Grouping;
  onGrouping: (g: Grouping) => void;
  range: Range;
}) {
  const csv = (chart: string) => centerApi.csvUrl(chart, { ...range, grouping });
  const usage = data.productUsageBySurface;
  const none = <Nothing>No queries recorded in this range.</Nothing>;
  const returning = data.monthlyUsersReturningDaily;
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Card title="Monthly users returning daily" csv={csv("monthly_returning")}>
        {usage.activeUsers === 0 || returning.length === 0 ? (
          none
        ) : (
          <Columns
            label="Monthly users returning daily"
            unit="percent"
            points={returning.map((r) => ({ key: r.month, value: r.percent }))}
          />
        )}
      </Card>
      <Card title="Total active users" csv={csv("active_users")}>
        <Field label="Group by">
          {(props) => (
            <NativeSelect
              {...props}
              className="w-40"
              value={grouping}
              onChange={(e) => onGrouping(e.target.value as Grouping)}
            >
              <option value="day">Day</option>
              <option value="week">Week</option>
              <option value="month">Month</option>
            </NativeSelect>
          )}
        </Field>
        {usage.activeUsers === 0 ? (
          none
        ) : (
          <Columns
            label="Total active users"
            unit="users"
            points={data.totalActiveUsers.series.map((r) => ({ key: r.bucket, value: r.users }))}
          />
        )}
      </Card>
      <Card title="Product usage by surface" csv={csv("surface_usage")}>
        {usage.activeUsers === 0 ? (
          none
        ) : (
          <>
            <p className="text-dense text-fg-muted">
              Share of {usage.activeUsers} active users. People count in every surface they used, so
              shares can add to more than 100%.
            </p>
            <Table
              label="Product usage by surface"
              head={["Surface", "Users", "Share", ""]}
              rows={usage.surfaces.map((s) => {
                const missing = s.users === 0 && UNRECORDED_SURFACES.has(s.surface);
                return {
                  key: s.surface,
                  cells: [
                    SURFACE_LABEL[s.surface] ?? s.surface,
                    missing ? (
                      <span key="none" className="text-fg-muted">
                        {NOT_RECORDED}
                      </span>
                    ) : (
                      s.users
                    ),
                    missing ? null : `${s.share}%`,
                    missing ? null : <Bar key="bar" share={s.share} />,
                  ],
                };
              })}
            />
          </>
        )}
      </Card>
      <Card title="Top power users" csv={csv("power_users")}>
        {data.topPowerUsers.length === 0 ? (
          none
        ) : (
          <Table
            label="Top power users"
            head={["User", "Active days", "Activity", "Days by surface"]}
            rows={data.topPowerUsers.map((u) => ({
              key: u.user_id,
              cells: [
                u.name || u.email,
                u.active_days,
                u.total_activity,
                Object.entries(u.surfaces)
                  .filter(([, n]) => n > 0)
                  .map(([s, n]) => `${SURFACE_LABEL[s] ?? s} ${n}`)
                  .join(", "),
              ],
            }))}
          />
        )}
      </Card>
    </div>
  );
}
