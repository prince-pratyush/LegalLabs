import { request, send } from "../http.js";

export interface Range {
  from: string;
  to: string;
}
export type Grouping = "day" | "week" | "month";

interface Report {
  dataAsOf: string | null;
  state: "ready" | "no_materialisation_yet";
  message?: string;
  range: Range;
}

export interface Overview extends Report {
  monthlyUsersReturningDaily: { month: string; days: number; percent: number }[];
  productUsageBySurface: {
    activeUsers: number;
    surfaces: { surface: string; users: number; share: number }[];
  };
  totalActiveUsers: { grouping: Grouping; series: { bucket: string; users: number }[] };
  topPowerUsers: {
    user_id: string;
    name: string;
    email: string;
    active_days: number;
    total_activity: number;
    surfaces: Record<string, number>;
  }[];
  recommendedActions: { key: string; title: string }[];
}

export interface Bucket {
  label: string;
  users: number;
  queries: number;
}

export interface Analytics extends Report {
  queriesOverTime: {
    granularity: "day" | "week";
    series: { bucket: string; with_sources: number; without_sources: number }[];
  };
  topPracticeAreas: Bucket[];
  topJobTitles: Bucket[];
  filtersNote?: string;
}

export interface UserRow {
  user_id: string;
  name: string;
  email: string;
  role: string;
  active_days: number;
  total_activity: number;
  threads: number;
  follow_ups: number;
  agent_runs: number;
  playbook_runs: number;
  rt_columns: number;
  word: number;
  last_active: string | null;
}

export interface UserPage {
  rows: UserRow[];
  total: number;
  page: number;
  page_size: number;
}

export interface Outcomes extends Report {
  methodology: string;
  hoursSaved: number;
  contractsReviewed: number;
  citations: { verified: number; flagged: number; rate: number | null };
  workflows: {
    workflow_type: string;
    count: number;
    hours_saved: number;
    turnaround_p50_seconds: number | null;
  }[];
}

export interface Baseline {
  workflow_type: string;
  hours_per_completion: number;
  note: string;
  is_default: boolean;
  cap_hours?: number;
}

export interface ExportJob {
  id: string;
  status: "queued" | "running" | "done" | "failed";
  params: { from?: string; to?: string };
  row_count: number | null;
  created_at: string;
}

const BASE = "/admin/analytics";

const query = (params: Record<string, string | number | undefined>) => {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") q.set(key, String(value));
  }
  const text = q.toString();
  return text ? `?${text}` : "";
};

export const centerApi = {
  overview: (range: Range, grouping: Grouping) =>
    request<Overview>(`${BASE}/overview${query({ ...range, grouping })}`),
  report: (params: Record<string, string | undefined>) =>
    request<Analytics>(`${BASE}/report${query(params)}`),
  users: (params: Record<string, string | number | undefined>) =>
    request<UserPage>(`${BASE}/users${query(params)}`),
  outcomes: (range: Range) => request<Outcomes>(`${BASE}/outcomes${query({ ...range })}`),
  baselines: async () => (await request<{ baselines: Baseline[] }>(`${BASE}/baselines`)).baselines,
  setBaseline: (type: string, hours: number, note: string) =>
    send<unknown>("PUT", `${BASE}/baselines/${encodeURIComponent(type)}`, { hours, note }),
  refresh: () => send<unknown>("POST", `${BASE}/refresh`),
  dismiss: (key: string) =>
    send<void>("POST", `${BASE}/actions/${encodeURIComponent(key)}/dismiss`),
  exports: async () => (await request<{ exports: ExportJob[] }>(`${BASE}/exports`)).exports,
  createExport: (input: Range & { include_former: boolean }) =>
    send<unknown>("POST", `${BASE}/exports`, input),
  roles: async () =>
    (await request<{ items: { id: string; name: string }[] }>("/admin/roles")).items,
  /** Plain links: the session cookie goes with them and the server names the file. */
  csvUrl: (chart: string, params: Record<string, string | undefined>) =>
    `/api/v1${BASE}/csv${query({ chart, ...params })}`,
  exportUrl: (id: string) => `/api/v1${BASE}/exports/${encodeURIComponent(id)}/download`,
};
