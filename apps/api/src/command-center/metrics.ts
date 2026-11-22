// Pure chart maths over analytics.daily rows. Nothing here reads usage_event.
import type { Counter, Surface } from "./record.js";

export const SURFACES: Surface[] = [
  "web",
  "word",
  "outlook",
  "review_tables",
  "agents",
  "apps",
  "email",
  "api",
  "mobile",
];
export const COUNTERS: Counter[] = [
  "threads",
  "follow_ups",
  "agent_runs",
  "playbook_runs",
  "rt_columns",
  "word",
  "outlook",
];

export interface PerUser {
  active: number;
  threads: number;
  follow_ups: number;
  agent_runs: number;
  playbook_runs: number;
  rt_columns: number;
  word: number;
  outlook: number;
}

export interface Metrics {
  dau: number;
  mau: number;
  dau_mau: number;
  queries: number;
  queries_with_sources: number;
  queries_without_sources: number;
  active_by_surface: Record<string, string[]>;
  per_user: Record<string, PerUser>;
  outcomes: Record<string, { count: number; turnaround_p50: number | null; hours_saved: number }>;
  citations_verified: number;
  citations_flagged: number;
  practice_areas: Record<string, { users: string[]; queries: number }>;
  titles: Record<string, { users: string[]; queries: number }>;
  guest_activity?: number;
}

export interface DailyRow {
  day: string;
  metrics: Metrics;
}

export type Grouping = "day" | "week" | "month";

export interface UserInfo {
  id: string;
  name: string;
  email: string;
  status: string;
  role: string;
  roleId: string | null;
}

export const round = (n: number, places = 2) => {
  const f = 10 ** places;
  return Math.round((n + Number.EPSILON) * f) / f;
};

/** The Monday of the ISO week a UTC day falls in. */
export function weekStart(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

export function bucketOf(day: string, grouping: Grouping): string {
  if (grouping === "day") return day;
  if (grouping === "week") return weekStart(day);
  return day.slice(0, 7);
}

const activeIds = (m: Metrics, allowed: Set<string> | null) =>
  Object.entries(m.per_user)
    .filter(([id, u]) => u.active === 1 && (!allowed || allowed.has(id)))
    .map(([id]) => id);

/** Mean of DAU/MAU over the days of each month in range, as a percentage. */
export function monthlyReturning(rows: DailyRow[]) {
  const months = new Map<string, number[]>();
  for (const r of rows) {
    const list = months.get(r.day.slice(0, 7)) ?? [];
    list.push(Number(r.metrics.dau_mau));
    months.set(r.day.slice(0, 7), list);
  }
  return [...months.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, ratios]) => ({
      month,
      days: ratios.length,
      percent: round((ratios.reduce((a, b) => a + b, 0) / ratios.length) * 100),
    }));
}

/** Share of distinct active users in range with at least one query on each surface. */
export function surfaceUsage(rows: DailyRow[], allowed: Set<string> | null) {
  const everyone = new Set<string>();
  const bySurface = new Map<string, Set<string>>(SURFACES.map((s) => [s, new Set<string>()]));
  for (const r of rows) {
    for (const id of activeIds(r.metrics, allowed)) everyone.add(id);
    for (const [surface, ids] of Object.entries(r.metrics.active_by_surface)) {
      const set = bySurface.get(surface);
      if (!set) continue;
      for (const id of ids) if (!allowed || allowed.has(id)) set.add(id);
    }
  }
  return {
    activeUsers: everyone.size,
    surfaces: SURFACES.map((surface) => {
      const users = bySurface.get(surface)?.size ?? 0;
      return {
        surface,
        users,
        share: everyone.size === 0 ? 0 : round((users / everyone.size) * 100),
      };
    }),
  };
}

/** Distinct active users per day, ISO week (keyed by its Monday) or month. */
export function activeUsers(rows: DailyRow[], grouping: Grouping, allowed: Set<string> | null) {
  const buckets = new Map<string, Set<string>>();
  for (const r of rows) {
    const key = bucketOf(r.day, grouping);
    const set = buckets.get(key) ?? new Set<string>();
    for (const id of activeIds(r.metrics, allowed)) set.add(id);
    buckets.set(key, set);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([bucket, users]) => ({ bucket, users: users.size }));
}

export interface UserTotals {
  userId: string;
  active_days: number;
  total_activity: number;
  threads: number;
  follow_ups: number;
  agent_runs: number;
  playbook_runs: number;
  rt_columns: number;
  word: number;
  outlook: number;
  last_active: string | null;
  surface_days: Record<string, number>;
}

/** Per-user sums over the range, for users the filters let through. */
export function userTotals(rows: DailyRow[], allowed: Set<string> | null): UserTotals[] {
  const totals = new Map<string, UserTotals>();
  for (const r of rows) {
    for (const [id, u] of Object.entries(r.metrics.per_user)) {
      if (allowed && !allowed.has(id)) continue;
      let t = totals.get(id);
      if (!t) {
        t = {
          userId: id,
          active_days: 0,
          total_activity: 0,
          threads: 0,
          follow_ups: 0,
          agent_runs: 0,
          playbook_runs: 0,
          rt_columns: 0,
          word: 0,
          outlook: 0,
          last_active: null,
          surface_days: {},
        };
        totals.set(id, t);
      }
      if (u.active === 1) {
        t.active_days += 1;
        if (!t.last_active || r.day > t.last_active) t.last_active = r.day;
      }
      for (const c of COUNTERS) {
        t[c] += u[c];
        t.total_activity += u[c];
      }
    }
    for (const [surface, ids] of Object.entries(r.metrics.active_by_surface)) {
      for (const id of ids) {
        const t = totals.get(id);
        if (t) t.surface_days[surface] = (t.surface_days[surface] ?? 0) + 1;
      }
    }
  }
  return [...totals.values()];
}

export function powerUsers(totals: UserTotals[], users: Map<string, UserInfo>) {
  return totals
    .filter((t) => t.active_days > 0)
    .sort(
      (a, b) =>
        b.active_days - a.active_days ||
        b.total_activity - a.total_activity ||
        (users.get(a.userId)?.email ?? a.userId).localeCompare(
          users.get(b.userId)?.email ?? b.userId,
        ),
    )
    .slice(0, 10)
    .map((t) => ({
      user_id: t.userId,
      name: users.get(t.userId)?.name ?? "",
      email: users.get(t.userId)?.email ?? "",
      active_days: t.active_days,
      total_activity: t.total_activity,
      surfaces: Object.fromEntries(
        SURFACES.filter((s) => (t.surface_days[s] ?? 0) > 0).map((s) => [
          s,
          t.surface_days[s] ?? 0,
        ]),
      ),
    }));
}

/** Queries with and without sources per day or ISO week. */
export function queriesOverTime(rows: DailyRow[], grouping: "day" | "week") {
  const buckets = new Map<string, { with_sources: number; without_sources: number }>();
  for (const r of rows) {
    const key = bucketOf(r.day, grouping);
    const b = buckets.get(key) ?? { with_sources: 0, without_sources: 0 };
    b.with_sources += r.metrics.queries_with_sources;
    b.without_sources += r.metrics.queries_without_sources;
    buckets.set(key, b);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([bucket, v]) => ({ bucket, ...v }));
}

/** Active users and queries per profile bucket (practice area or title). */
export function profileBuckets(
  rows: DailyRow[],
  key: "practice_areas" | "titles",
  allowed: Set<string> | null,
  only: string[] | null,
) {
  const out = new Map<string, { users: Set<string>; queries: number }>();
  for (const r of rows) {
    for (const [label, v] of Object.entries(r.metrics[key])) {
      if (only && !only.includes(label)) continue;
      const entry = out.get(label) ?? { users: new Set<string>(), queries: 0 };
      for (const id of v.users) if (!allowed || allowed.has(id)) entry.users.add(id);
      entry.queries += v.queries;
      out.set(label, entry);
    }
  }
  return [...out.entries()]
    .filter(([, v]) => v.users.size > 0)
    .map(([label, v]) => ({ label, users: v.users.size, queries: v.queries }))
    .sort((a, b) => b.users - a.users || b.queries - a.queries || a.label.localeCompare(b.label));
}

/** Median of values weighted by how many completions each stands for. */
export function weightedMedian(items: { value: number; weight: number }[]): number | null {
  const sorted = items.filter((i) => i.weight > 0).sort((a, b) => a.value - b.value);
  const total = sorted.reduce((s, i) => s + i.weight, 0);
  if (total === 0) return null;
  let seen = 0;
  for (const i of sorted) {
    seen += i.weight;
    if (seen * 2 >= total) return i.value;
  }
  return null;
}

export function outcomeTotals(rows: DailyRow[]) {
  const byType = new Map<
    string,
    { count: number; hours: number; medians: { value: number; weight: number }[] }
  >();
  let verified = 0;
  let flagged = 0;
  for (const r of rows) {
    verified += r.metrics.citations_verified;
    flagged += r.metrics.citations_flagged;
    for (const [type, o] of Object.entries(r.metrics.outcomes)) {
      const e = byType.get(type) ?? { count: 0, hours: 0, medians: [] };
      e.count += o.count;
      e.hours += Number(o.hours_saved);
      if (o.turnaround_p50 !== null)
        e.medians.push({ value: Number(o.turnaround_p50), weight: o.count });
      byType.set(type, e);
    }
  }
  const workflows = [...byType.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([workflow_type, e]) => ({
      workflow_type,
      count: e.count,
      hours_saved: round(e.hours),
      turnaround_p50_seconds: weightedMedian(e.medians),
    }));
  const count = (t: string) => byType.get(t)?.count ?? 0;
  return {
    hoursSaved: round([...byType.values()].reduce((s, e) => s + e.hours, 0)),
    contractsReviewed: count("contract_reviewed"),
    requestsResolved: count("request_resolved"),
    medianTurnaround: workflows.map((w) => ({
      workflow_type: w.workflow_type,
      seconds: w.turnaround_p50_seconds,
    })),
    citations: {
      verified,
      flagged,
      rate: verified + flagged === 0 ? null : round(verified / (verified + flagged), 4),
    },
    workflows,
  };
}
