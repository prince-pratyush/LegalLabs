import { promisify } from "node:util";
import { gzip as gzipCb } from "node:zlib";
import type { ObjectStore } from "@legallabs/storage";
import type pg from "pg";
import { audit } from "../auth/audit.js";
import type { Client, Principal } from "../auth/auth.js";
import { asApp } from "../db.js";
import { type Cell, csvLine, toCsv } from "./csv.js";
import {
  activeUsers,
  type DailyRow,
  type Grouping,
  monthlyReturning,
  outcomeTotals,
  powerUsers,
  profileBuckets,
  queriesOverTime,
  round,
  SURFACES,
  surfaceUsage,
  type UserInfo,
  userTotals,
} from "./metrics.js";
import type { WorkflowType } from "./record.js";

export { recordOutcome, recordUsage } from "./record.js";

const gzip = promisify(gzipCb);

export const METHODOLOGY = "Captured from completions, not surveys; baselines are yours.";
export const MAX_RANGE_DAYS = 400;
export const MAX_EXPORT_DAYS = 366;
const EXPORT_BATCH = 5000;
const GZIP_OVER_BYTES = 50 * 1024 * 1024;
const DISMISS_DAYS = 30;
const ACTION_KEYS = ["invited_not_signed_in", "no_materialisation"];

/** The columns of the event export, in order (spec 4.3). No prompt text, file names or quotes. */
export const EXPORT_COLUMNS = [
  "event_id",
  "timestamp_utc",
  "user_email",
  "user_status",
  "user_role",
  "groups",
  "access_point",
  "surface",
  "subsurface",
  "action",
  "action_class",
  "object_type",
  "object_id",
  "matter_ref",
  "source_kinds",
  "document_count",
  "model",
  "input_tokens",
  "output_tokens",
  "cost_usd",
  "duration_ms",
] as const;

export const DEFAULT_BASELINES: Record<WorkflowType, number> = {
  contract_reviewed: 2.0,
  redline_applied: 1.0,
  table_exported: 0.1,
  draft_exported: 1.5,
  research_memo_completed: 4.0,
  request_resolved: 0.5,
  chronology_generated: 6.0,
  translation_completed: 1.0,
  proofread_applied: 0.5,
};
export const WORKFLOW_TYPES = Object.keys(DEFAULT_BASELINES) as WorkflowType[];
const TABLE_EXPORT_CAP_HOURS = 40;

export class CommandCenterError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 422 | 429,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface Range {
  /** Inclusive UTC dates, YYYY-MM-DD. */
  from: string;
  to: string;
}

export interface Filters {
  groups?: string[];
  roles?: string[];
  practiceAreas?: string[];
}

export type UserSort =
  | "name"
  | "email"
  | "role"
  | "active_days"
  | "total_activity"
  | "threads"
  | "follow_ups"
  | "agent_runs"
  | "playbook_runs"
  | "rt_columns"
  | "word"
  | "outlook"
  | "last_active";

export interface UsersQuery {
  range?: Range;
  filters?: Filters;
  sort?: UserSort;
  dir?: "asc" | "desc";
  q?: string;
  page?: number;
  pageSize?: number;
}

export interface UserRow {
  user_id: string;
  name: string;
  email: string;
  role: string;
  status: string;
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
}

export interface ExportInput {
  range: Range;
  surfaces?: string[];
  includeFormer?: boolean;
}

export interface ExportJob {
  id: string;
  status: "queued" | "running" | "done" | "failed";
  params: unknown;
  row_count: number | null;
  bytes: number | null;
  gzip: boolean;
  error: string | null;
  created_at: string;
  finished_at: string | null;
  expires_at: string | null;
}

export type ReportChart =
  | "monthly_returning"
  | "surface_usage"
  | "active_users"
  | "power_users"
  | "queries_over_time"
  | "practice_areas"
  | "job_titles"
  | "outcomes";

export interface RecommendedAction {
  key: string;
  title: string;
  button: string;
  link: string;
}

export interface CommandCenter {
  overview(p: Principal, q: { range?: Range; grouping?: Grouping }): Promise<Overview>;
  analytics(
    p: Principal,
    q: { range?: Range; granularity?: "day" | "week"; filters?: Filters },
  ): Promise<AnalyticsReport>;
  usersByActivity(
    p: Principal,
    q: UsersQuery,
  ): Promise<{ rows: UserRow[]; total: number; page: number; page_size: number }>;
  outcomes(p: Principal, q: { range?: Range }): Promise<OutcomesReport>;
  baselines(p: Principal): Promise<BaselineRow[]>;
  setBaseline(
    p: Principal,
    type: WorkflowType,
    input: { hours: number; note?: string },
    client: Client,
  ): Promise<BaselineRow[]>;
  /** One chart or table as CSV; the outcomes file carries the methodology text. */
  csv(
    p: Principal,
    chart: ReportChart | "users",
    q: {
      range?: Range;
      grouping?: Grouping;
      granularity?: "day" | "week";
      filters?: Filters;
      users?: UsersQuery;
    },
  ): Promise<{ filename: string; text: string }>;
  refresh(p: Principal): Promise<{ refreshedAt: string }>;
  recommendedActions(p: Principal): Promise<RecommendedAction[]>;
  dismissAction(p: Principal, key: string): Promise<void>;
  createExport(p: Principal, input: ExportInput, client: Client): Promise<ExportJob>;
  listExports(p: Principal): Promise<ExportJob[]>;
  downloadExport(
    p: Principal,
    id: string,
  ): Promise<{ bytes: Uint8Array; filename: string; gzip: boolean }>;
}

export interface Overview {
  dataAsOf: string | null;
  state: "ready" | "no_materialisation_yet";
  message?: string;
  range: Range;
  monthlyUsersReturningDaily: { month: string; days: number; percent: number }[];
  productUsageBySurface: {
    activeUsers: number;
    surfaces: { surface: string; users: number; share: number }[];
  };
  totalActiveUsers: { grouping: Grouping; series: { bucket: string; users: number }[] };
  topPowerUsers: ReturnType<typeof powerUsers>;
  recommendedActions: RecommendedAction[];
}

export interface AnalyticsReport {
  dataAsOf: string | null;
  state: "ready" | "no_materialisation_yet";
  message?: string;
  range: Range;
  queriesOverTime: { granularity: "day" | "week"; series: ReturnType<typeof queriesOverTime> };
  topPracticeAreas: ReturnType<typeof profileBuckets>;
  topJobTitles: ReturnType<typeof profileBuckets>;
  /** Group and role filters narrow people, not query totals, which daily keeps only in sum. */
  filtersNote?: string;
}

export interface BaselineRow {
  workflow_type: WorkflowType;
  hours_per_completion: number;
  note: string;
  is_default: boolean;
  updated_at: string | null;
  /** Review tables count 0.1 hours a row, to this many hours at most. */
  cap_hours?: number;
}

export interface OutcomesReport extends ReturnType<typeof outcomeTotals> {
  dataAsOf: string | null;
  state: "ready" | "no_materialisation_yet";
  message?: string;
  range: Range;
  methodology: string;
}

const dayMs = 86_400_000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function defaultRange(nowMs: number, days = 30): Range {
  const to = isoDay(nowMs);
  return { from: isoDay(nowMs - (days - 1) * dayMs), to };
}

export const spanDays = (r: Range) =>
  Math.round((Date.parse(`${r.to}T00:00:00Z`) - Date.parse(`${r.from}T00:00:00Z`)) / dayMs) + 1;

function checkRange(r: Range, max: number) {
  const n = spanDays(r);
  if (!Number.isFinite(n) || n < 1) {
    throw new CommandCenterError(400, "INVALID_REQUEST", "The range ends before it starts.");
  }
  if (n > max) {
    throw new CommandCenterError(422, "RANGE_TOO_LARGE", `Choose a range of at most ${max} days.`);
  }
}

/** The next 00/06/12/18 UTC refresh after now. */
function nextRefresh(nowMs: number): string {
  const slot = 6 * 3_600_000;
  return new Date((Math.floor(nowMs / slot) + 1) * slot).toISOString();
}

export function createCommandCenter(
  pool: pg.Pool,
  options: { store: ObjectStore; now?: () => number; gzipOverBytes?: number },
): CommandCenter {
  const now = options.now ?? Date.now;
  const gzipOver = options.gzipOverBytes ?? GZIP_OVER_BYTES;

  async function withReporting<T>(
    p: Principal,
    work: (db: pg.PoolClient) => Promise<T>,
    also?: string,
  ): Promise<T> {
    return asApp(pool, p, async (db) => {
      const { rows } = await db.query<{ ok: boolean; extra: boolean }>(
        "select core.has_permission('admin.reporting') ok, core.has_permission($1) extra",
        [also ?? "admin.reporting"],
      );
      if (!rows[0]?.ok || (also && !rows[0]?.extra)) {
        throw new CommandCenterError(403, "FORBIDDEN", "You don't have access to reporting.");
      }
      return work(db);
    });
  }

  async function dailyRows(db: pg.PoolClient, ws: string, range: Range): Promise<DailyRow[]> {
    const { rows } = await db.query<DailyRow>(
      `select to_char(day, 'YYYY-MM-DD') as day, metrics from analytics.daily
        where workspace_id = $1 and day between $2::date and $3::date order by day`,
      [ws, range.from, range.to],
    );
    return rows;
  }

  async function dataAsOf(db: pg.PoolClient, ws: string) {
    const { rows } = await db.query<{ at: string | null }>(
      "select materialised_at as at from analytics.refresh_state where workspace_id = $1",
      [ws],
    );
    const at = rows[0]?.at ?? null;
    return at ? new Date(at).toISOString() : null;
  }

  async function members(db: pg.PoolClient, ws: string) {
    const { rows } = await db.query<{
      id: string;
      name: string;
      email: string;
      status: string;
      role_id: string | null;
      role: string;
    }>(
      `select u.id, u.name, u.email, u.status, u.role_id, coalesce(r.name, '') as role
         from core."user" u left join core.role r on r.workspace_id = u.workspace_id and r.id = u.role_id
        where u.workspace_id = $1 and u.kind = 'member'`,
      [ws],
    );
    return new Map<string, UserInfo>(
      rows.map((r) => [
        r.id,
        {
          id: r.id,
          name: r.name,
          email: r.email,
          status: r.status,
          role: r.role,
          roleId: r.role_id,
        },
      ]),
    );
  }

  async function allowedUsers(
    db: pg.PoolClient,
    ws: string,
    f: Filters | undefined,
  ): Promise<Set<string> | null> {
    if (!f || (!f.groups?.length && !f.roles?.length && !f.practiceAreas?.length)) return null;
    const { rows } = await db.query<{ id: string }>(
      `select u.id from core."user" u
        where u.workspace_id = $1 and u.kind = 'member'
          and ($2::uuid[] is null or u.role_id = any ($2))
          and ($3::uuid[] is null or exists (
                select 1 from core.group_member m
                 where m.workspace_id = u.workspace_id and m.user_id = u.id
                   and m.group_id = any ($3)))
          and ($4::text[] is null
               or coalesce(nullif(btrim(u.profile ->> 'practice_area'), ''), 'Unknown') = any ($4))`,
      [
        ws,
        f.roles?.length ? f.roles : null,
        f.groups?.length ? f.groups : null,
        f.practiceAreas?.length ? f.practiceAreas : null,
      ],
    );
    return new Set(rows.map((r) => r.id));
  }

  const notReady = (asOf: string | null) =>
    asOf === null
      ? ({
          state: "no_materialisation_yet",
          message: `First refresh at ${nextRefresh(now())}`,
        } as const)
      : ({ state: "ready" } as const);

  async function actionsFor(db: pg.PoolClient, p: Principal): Promise<RecommendedAction[]> {
    const out: RecommendedAction[] = [];
    const invited = await db.query<{ n: number }>(
      `select count(*)::int as n from core."user"
        where workspace_id = $1 and kind = 'member' and status = 'invited'
          and created_at < now() - interval '30 days'`,
      [p.workspaceId],
    );
    const n = invited.rows[0]?.n ?? 0;
    if (n > 0) {
      out.push({
        key: "invited_not_signed_in",
        title: `${n} invited ${n === 1 ? "user has" : "users have"} not signed in for 30 days`,
        button: "Manage",
        link: "/admin/users?status=invited",
      });
    }
    if ((await dataAsOf(db, p.workspaceId)) === null) {
      out.push({
        key: "no_materialisation",
        title: "Usage data has not been refreshed yet",
        button: "Open",
        link: "/admin/command-center/overview",
      });
    }
    // Retention at workspace scope is not stored as a policy yet, so there is no such action.
    const dismissed = await db.query<{ action_key: string }>(
      `select action_key from analytics.action_dismissal
        where user_id = $1 and dismissed_until > now()`,
      [p.userId],
    );
    const hidden = new Set(dismissed.rows.map((r) => r.action_key));
    return out.filter((a) => !hidden.has(a.key));
  }

  function userRows(
    rows: DailyRow[],
    users: Map<string, UserInfo>,
    allowed: Set<string> | null,
  ): UserRow[] {
    return userTotals(rows, allowed).flatMap((t) => {
      const u = users.get(t.userId);
      if (!u) return [];
      return [
        {
          user_id: t.userId,
          name: u.name,
          email: u.email,
          role: u.role,
          status: u.status,
          active_days: t.active_days,
          total_activity: t.total_activity,
          threads: t.threads,
          follow_ups: t.follow_ups,
          agent_runs: t.agent_runs,
          playbook_runs: t.playbook_runs,
          rt_columns: t.rt_columns,
          word: t.word,
          outlook: t.outlook,
          last_active: t.last_active,
        },
      ];
    });
  }

  function sortRows(rows: UserRow[], sort: UserSort, dir: "asc" | "desc"): UserRow[] {
    const sign = dir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const x = a[sort];
      const y = b[sort];
      let c = 0;
      if (x === y) c = 0;
      else if (x === null) c = -1;
      else if (y === null) c = 1;
      else
        c =
          typeof x === "number" && typeof y === "number"
            ? x - y
            : String(x).localeCompare(String(y));
      return c * sign || a.email.localeCompare(b.email);
    });
  }

  async function usersTable(p: Principal, q: UsersQuery) {
    const range = q.range ?? defaultRange(now());
    checkRange(range, MAX_RANGE_DAYS);
    return withReporting(p, async (db) => {
      const rows = await dailyRows(db, p.workspaceId, range);
      const users = await members(db, p.workspaceId);
      const allowed = await allowedUsers(db, p.workspaceId, q.filters);
      let list = userRows(rows, users, allowed);
      const needle = q.q?.trim().toLowerCase();
      if (needle) {
        list = list.filter(
          (r) => r.name.toLowerCase().includes(needle) || r.email.toLowerCase().includes(needle),
        );
      }
      list = sortRows(list, q.sort ?? "active_days", q.dir ?? "desc");
      const pageSize = Math.min(Math.max(q.pageSize ?? 25, 1), 200);
      const page = Math.max(q.page ?? 1, 1);
      return {
        all: list,
        rows: list.slice((page - 1) * pageSize, page * pageSize),
        total: list.length,
        page,
        page_size: pageSize,
      };
    });
  }

  const service: CommandCenter = {
    async overview(p, q) {
      const range = q.range ?? defaultRange(now());
      const grouping = q.grouping ?? "day";
      checkRange(range, MAX_RANGE_DAYS);
      return withReporting(p, async (db) => {
        const asOf = await dataAsOf(db, p.workspaceId);
        const rows = await dailyRows(db, p.workspaceId, range);
        const users = await members(db, p.workspaceId);
        const recommendedActions = await actionsFor(db, p);
        return {
          dataAsOf: asOf,
          ...notReady(asOf),
          range,
          monthlyUsersReturningDaily: monthlyReturning(rows),
          productUsageBySurface: surfaceUsage(rows, null),
          totalActiveUsers: { grouping, series: activeUsers(rows, grouping, null) },
          topPowerUsers: powerUsers(userTotals(rows, null), users),
          recommendedActions,
        };
      });
    },

    async analytics(p, q) {
      const range = q.range ?? defaultRange(now());
      const granularity = q.granularity ?? "day";
      checkRange(range, MAX_RANGE_DAYS);
      return withReporting(p, async (db) => {
        const asOf = await dataAsOf(db, p.workspaceId);
        const rows = await dailyRows(db, p.workspaceId, range);
        const allowed = await allowedUsers(db, p.workspaceId, q.filters);
        const userFiltered = Boolean(q.filters?.groups?.length || q.filters?.roles?.length);
        return {
          dataAsOf: asOf,
          ...notReady(asOf),
          range,
          queriesOverTime: { granularity, series: queriesOverTime(rows, granularity) },
          topPracticeAreas: profileBuckets(
            rows,
            "practice_areas",
            allowed,
            q.filters?.practiceAreas?.length ? q.filters.practiceAreas : null,
          ),
          topJobTitles: profileBuckets(rows, "titles", allowed, null),
          ...(userFiltered
            ? {
                filtersNote:
                  "Query counts are totals for the workspace; group and role filters narrow the people counted.",
              }
            : {}),
        };
      });
    },

    async usersByActivity(p, q) {
      const { all: _all, ...page } = await usersTable(p, q);
      return page;
    },

    async outcomes(p, q) {
      const range = q.range ?? defaultRange(now());
      checkRange(range, MAX_RANGE_DAYS);
      return withReporting(p, async (db) => {
        const asOf = await dataAsOf(db, p.workspaceId);
        const rows = await dailyRows(db, p.workspaceId, range);
        return {
          dataAsOf: asOf,
          ...notReady(asOf),
          range,
          methodology: METHODOLOGY,
          ...outcomeTotals(rows),
        };
      });
    },

    async baselines(p) {
      return withReporting(p, (db) => readBaselines(db, p.workspaceId));
    },

    async setBaseline(p, type, input, client) {
      if (!WORKFLOW_TYPES.includes(type)) {
        throw new CommandCenterError(400, "INVALID_REQUEST", "Unknown workflow type.");
      }
      const hours = round(input.hours);
      return withReporting(
        p,
        async (db) => {
          const before = (await readBaselines(db, p.workspaceId)).find(
            (b) => b.workflow_type === type,
          );
          await db.query("select analytics.set_baseline($1, $2, $3)", [
            type,
            hours,
            input.note ?? "",
          ]);
          // Ids and values only: the note is the admin's own text, so it stays out of the log.
          await audit(db, p, client, "analytics.baseline_changed", "analytics_baseline", type, {
            workflow_type: type,
            previous_hours: before?.hours_per_completion ?? null,
            hours_per_completion: hours,
          });
          return readBaselines(db, p.workspaceId);
        },
        "admin.config",
      );
    },

    async csv(p, chart, q) {
      const range = q.range ?? defaultRange(now());
      const stamp = `${range.from}_${range.to}`;
      switch (chart) {
        case "monthly_returning": {
          const o = await service.overview(p, { range });
          return {
            filename: `monthly-users-returning-daily_${stamp}.csv`,
            text: toCsv(
              ["month", "days", "percent_returning_daily"],
              o.monthlyUsersReturningDaily.map((r) => [r.month, r.days, r.percent]),
            ),
          };
        }
        case "surface_usage": {
          const o = await service.overview(p, { range });
          return {
            filename: `product-usage-by-surface_${stamp}.csv`,
            text: toCsv(
              ["surface", "active_users", "share_percent"],
              o.productUsageBySurface.surfaces.map((r) => [r.surface, r.users, r.share]),
            ),
          };
        }
        case "active_users": {
          const grouping = q.grouping ?? "day";
          const o = await service.overview(p, { range, grouping });
          return {
            filename: `total-active-users-${grouping}_${stamp}.csv`,
            text: toCsv(
              [grouping, "active_users"],
              o.totalActiveUsers.series.map((r) => [r.bucket, r.users]),
            ),
          };
        }
        case "power_users": {
          const o = await service.overview(p, { range });
          return {
            filename: `top-power-users_${stamp}.csv`,
            text: toCsv(
              ["rank", "name", "email", "active_days", "total_activity", ...SURFACES],
              o.topPowerUsers.map((r, i) => [
                i + 1,
                r.name,
                r.email,
                r.active_days,
                r.total_activity,
                ...SURFACES.map((s) => r.surfaces[s] ?? 0),
              ]),
            ),
          };
        }
        case "queries_over_time": {
          const a = await service.analytics(p, {
            range,
            ...(q.granularity ? { granularity: q.granularity } : {}),
            ...(q.filters ? { filters: q.filters } : {}),
          });
          return {
            filename: `queries-over-time_${stamp}.csv`,
            text: toCsv(
              [a.queriesOverTime.granularity, "with_sources", "without_sources"],
              a.queriesOverTime.series.map((r) => [r.bucket, r.with_sources, r.without_sources]),
            ),
          };
        }
        case "practice_areas":
        case "job_titles": {
          const a = await service.analytics(p, {
            range,
            ...(q.filters ? { filters: q.filters } : {}),
          });
          const list = chart === "practice_areas" ? a.topPracticeAreas : a.topJobTitles;
          return {
            filename: `top-${chart.replace("_", "-")}_${stamp}.csv`,
            text: toCsv(
              [
                chart === "practice_areas" ? "practice_area" : "job_title",
                "active_users",
                "queries",
              ],
              list.map((r) => [r.label, r.users, r.queries]),
            ),
          };
        }
        case "users": {
          const { all } = await usersTable(p, {
            ...q.users,
            range,
            ...(q.filters ? { filters: q.filters } : {}),
          });
          return {
            filename: `users-by-activity_${stamp}.csv`,
            text: toCsv(
              [
                "name",
                "email",
                "role",
                "active_days",
                "total_activity",
                "threads",
                "follow_ups",
                "agent_runs",
                "playbook_runs",
                "rt_columns",
                "word",
                "outlook",
                "last_active",
              ],
              all.map((r) => [
                r.name,
                r.email,
                r.role,
                r.active_days,
                r.total_activity,
                r.threads,
                r.follow_ups,
                r.agent_runs,
                r.playbook_runs,
                r.rt_columns,
                r.word,
                r.outlook,
                r.last_active,
              ]),
            ),
          };
        }
        case "outcomes": {
          const o = await service.outcomes(p, { range });
          const base = new Map(
            (await service.baselines(p)).map((b) => [b.workflow_type, b.hours_per_completion]),
          );
          const lines: Cell[][] = [
            ["Methodology", METHODOLOGY],
            ["Range", `${range.from} to ${range.to}`],
            [],
            [
              "workflow_type",
              "completions",
              "hours_saved",
              "median_turnaround_seconds",
              "baseline_hours_now",
            ],
            ...o.workflows.map((w) => [
              w.workflow_type,
              w.count,
              w.hours_saved,
              w.turnaround_p50_seconds,
              base.get(w.workflow_type as WorkflowType) ?? null,
            ]),
            [],
            ["metric", "value"],
            ["hours_saved", o.hoursSaved],
            ["contracts_reviewed", o.contractsReviewed],
            ["requests_resolved", o.requestsResolved],
            ["citations_verified", o.citations.verified],
            ["citations_flagged", o.citations.flagged],
            ["citation_verified_rate", o.citations.rate],
          ];
          return {
            filename: `outcomes_${stamp}.csv`,
            text: lines.map(csvLine).join(""),
          };
        }
      }
    },

    async refresh(p) {
      return withReporting(p, async (db) => {
        try {
          const { rows } = await db.query<{ at: string }>(
            "select analytics.request_refresh() as at",
          );
          return { refreshedAt: new Date(rows[0]?.at ?? now()).toISOString() };
        } catch (err) {
          if (err instanceof Error && err.message.includes("REFRESH_TOO_SOON")) {
            throw new CommandCenterError(
              429,
              "REFRESH_TOO_SOON",
              "The data was refreshed less than an hour ago.",
            );
          }
          throw err;
        }
      });
    },

    async recommendedActions(p) {
      return withReporting(p, (db) => actionsFor(db, p));
    },

    async dismissAction(p, key) {
      return withReporting(p, async (db) => {
        if (!ACTION_KEYS.includes(key)) {
          throw new CommandCenterError(404, "NOT_FOUND", "That action wasn't found.");
        }
        await db.query(
          `insert into analytics.action_dismissal (workspace_id, user_id, action_key, dismissed_until)
           values ($1, $2, $3, now() + make_interval(days => $4))
           on conflict (user_id, action_key) do update set dismissed_until = excluded.dismissed_until`,
          [p.workspaceId, p.userId, key, DISMISS_DAYS],
        );
      });
    },

    async createExport(p, input, client) {
      checkRange(input.range, MAX_EXPORT_DAYS);
      const surfaces = input.surfaces?.length ? input.surfaces : null;
      if (surfaces?.some((s) => !(SURFACES as string[]).includes(s))) {
        throw new CommandCenterError(400, "INVALID_REQUEST", "Unknown surface.");
      }
      const params = {
        from: input.range.from,
        to: input.range.to,
        surfaces,
        include_former: input.includeFormer ?? true,
      };
      const id = await withReporting(p, async (db) => {
        const { rows } = await db.query<{ id: string }>(
          "select analytics.create_export_job($1::jsonb) as id",
          [JSON.stringify(params)],
        );
        const jobId = rows[0]?.id ?? "";
        await audit(db, p, client, "analytics.export_created", "analytics_export", jobId, params);
        return jobId;
      });

      const lo = `${input.range.from}T00:00:00Z`;
      const hi = new Date(Date.parse(`${input.range.to}T00:00:00Z`) + dayMs).toISOString();
      const chunks: Buffer[] = [Buffer.from(csvLine([...EXPORT_COLUMNS]), "utf8")];
      let total = chunks[0]?.length ?? 0;
      let count = 0;
      try {
        let after: { at: string; id: string } | null = null;
        for (;;) {
          const batch: Record<string, unknown>[] = await withReporting(p, async (db) => {
            const { rows } = await db.query<Record<string, unknown>>(
              "select * from analytics.export_events($1, $2, $3, $4, $5, $6, $7)",
              [
                lo,
                hi,
                surfaces,
                params.include_former,
                after?.at ?? null,
                after?.id ?? null,
                EXPORT_BATCH,
              ],
            );
            return rows;
          });
          if (batch.length === 0) break;
          const text = batch.map((r) => csvLine(EXPORT_COLUMNS.map((c) => r[c] as Cell))).join("");
          const buf = Buffer.from(text, "utf8");
          chunks.push(buf);
          total += buf.length;
          count += batch.length;
          const last = batch[batch.length - 1] as Record<string, unknown>;
          after = { at: String(last.cursor_at), id: String(last.event_id) };
          if (batch.length < EXPORT_BATCH) break;
        }
        let body: Buffer = Buffer.concat(chunks, total);
        const zipped = body.length > gzipOver;
        if (zipped) body = await gzip(body);
        const key = `exports/${p.workspaceId}/${id}.csv${zipped ? ".gz" : ""}`;
        await options.store.putIfAbsent(key, body);
        await withReporting(p, (db) =>
          db.query("select analytics.finish_export_job($1, 'done', $2, $3, $4, $5, null)", [
            id,
            count,
            key,
            body.length,
            zipped,
          ]),
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : "export failed";
        await withReporting(p, (db) =>
          db.query(
            "select analytics.finish_export_job($1, 'failed', null, null, null, false, $2)",
            [id, message],
          ),
        ).catch(() => {});
        throw err;
      }
      const job = (await service.listExports(p)).find((j) => j.id === id);
      if (!job) throw new CommandCenterError(404, "NOT_FOUND", "That export wasn't found.");
      return job;
    },

    async listExports(p) {
      return withReporting(p, async (db) => {
        const { rows } = await db.query<ExportJob>(
          `select id, status, params, row_count, bytes::float8 as bytes, gzip, error,
                  created_at, finished_at, expires_at
             from analytics.export_job
            where workspace_id = $1 and (expires_at is null or expires_at > now())
            order by created_at desc, id desc limit 100`,
          [p.workspaceId],
        );
        return rows.map((r) => ({
          ...r,
          created_at: new Date(r.created_at).toISOString(),
          finished_at: r.finished_at ? new Date(r.finished_at).toISOString() : null,
          expires_at: r.expires_at ? new Date(r.expires_at).toISOString() : null,
        }));
      });
    },

    async downloadExport(p, id) {
      const row = await withReporting(p, async (db) => {
        const { rows } = await db.query<{ storage_key: string; gzip: boolean }>(
          `select storage_key, gzip from analytics.export_job
            where id = $1 and workspace_id = $2 and status = 'done' and expires_at > now()`,
          [id, p.workspaceId],
        );
        return rows[0] ?? null;
      });
      const bytes = row ? await options.store.get(row.storage_key) : null;
      if (!row || !bytes) {
        throw new CommandCenterError(404, "NOT_FOUND", "That export wasn't found or has expired.");
      }
      return { bytes, filename: `usage-events-${id}.csv${row.gzip ? ".gz" : ""}`, gzip: row.gzip };
    },
  };

  async function readBaselines(db: pg.PoolClient, ws: string): Promise<BaselineRow[]> {
    const { rows } = await db.query<{
      workflow_type: WorkflowType;
      hours: string;
      note: string;
      updated_at: string;
    }>(
      `select workflow_type, hours_per_completion as hours, note, updated_at
         from analytics.outcome_baseline where workspace_id = $1`,
      [ws],
    );
    const set = new Map(rows.map((r) => [r.workflow_type, r]));
    return WORKFLOW_TYPES.map((type) => {
      const r = set.get(type);
      return {
        workflow_type: type,
        hours_per_completion: r ? Number(r.hours) : DEFAULT_BASELINES[type],
        note: r?.note ?? "",
        is_default: !r,
        updated_at: r ? new Date(r.updated_at).toISOString() : null,
        ...(type === "table_exported" ? { cap_hours: TABLE_EXPORT_CAP_HOURS } : {}),
      };
    });
  }

  return service;
}
