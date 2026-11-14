export type HistoryType = "assist" | "deep_analysis" | "draft";
export type HistoryStatus = "done" | "running" | "needs_input" | "failed";

export type HistoryRow = {
  id: string;
  title: string;
  type: HistoryType;
  matter?: string | null;
  documentCount: number;
  model?: string | null;
  costUsd?: number | null;
  /** ISO timestamp. */
  lastActivityAt: string;
  status: HistoryStatus;
  favourite: boolean;
  /** The caller lost access to the matter, so the title is withheld. */
  restricted: boolean;
};

export type DocBucket = "0" | "1" | "2-10" | "11-100" | ">100";

export function docBucket(n: number): DocBucket {
  if (n <= 0) return "0";
  if (n === 1) return "1";
  if (n <= 10) return "2-10";
  if (n <= 100) return "11-100";
  return ">100";
}

export type GroupBy = "none" | "day" | "week" | "month" | "type";

export const TYPE_LABELS: Record<HistoryType, string> = {
  assist: "Assist",
  deep_analysis: "Deep analysis",
  draft: "Draft",
};

const dayOf = (d: Date) => d.toISOString().slice(0, 10);

// Weeks start on Monday in UTC, so a group doesn't move with the viewer's clock.
function weekStart(d: Date): string {
  const copy = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  copy.setUTCDate(copy.getUTCDate() - ((copy.getUTCDay() + 6) % 7));
  return dayOf(copy);
}

export const UNKNOWN_DATE = "Unknown date";

/** Milliseconds, or NaN for a missing or malformed timestamp. */
export const activityTime = (row: HistoryRow) => Date.parse(row.lastActivityAt);

function keyOf(row: HistoryRow, by: GroupBy, now: Date): string {
  if (by === "none") return "All";
  if (by === "type") return TYPE_LABELS[row.type];
  const time = activityTime(row);
  // A bad timestamp gets its own group instead of throwing from toISOString.
  if (Number.isNaN(time)) return UNKNOWN_DATE;
  const at = new Date(time);
  switch (by) {
    case "day":
      return dayOf(at) === dayOf(now) ? "Today" : dayOf(at);
    case "week":
      return `Week of ${weekStart(at)}`;
    case "month":
      return at.toISOString().slice(0, 7);
  }
}

/** Groups newest first, rows newest first inside each group. */
export function groupRows(
  rows: readonly HistoryRow[],
  by: GroupBy,
  now: Date,
): { key: string; rows: HistoryRow[] }[] {
  // Parsed, not compared as strings, so mixed offsets sort by real time; unknown dates go last.
  const time = (row: HistoryRow) => {
    const t = activityTime(row);
    return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
  };
  const sorted = [...rows].sort((a, b) => time(b) - time(a));
  const groups = new Map<string, HistoryRow[]>();
  for (const row of sorted) {
    const key = keyOf(row, by, now);
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }
  return [...groups].map(([key, list]) => ({ key, rows: list }));
}

export type DatePreset = "any" | "7d" | "30d" | "90d";

export type HistoryFilters = {
  search: string;
  type: HistoryType | "any";
  date: DatePreset;
  docs: DocBucket | "any";
  favouritesOnly: boolean;
};

export const NO_FILTERS: HistoryFilters = {
  search: "",
  type: "any",
  date: "any",
  docs: "any",
  favouritesOnly: false,
};

const DAYS: Record<Exclude<DatePreset, "any">, number> = { "7d": 7, "30d": 30, "90d": 90 };
const DAY_MS = 24 * 60 * 60 * 1000;

export function filterRows(
  rows: readonly HistoryRow[],
  filters: HistoryFilters,
  now: Date,
): HistoryRow[] {
  const q = filters.search.trim().toLowerCase();
  const since = filters.date === "any" ? null : now.getTime() - DAYS[filters.date] * DAY_MS;
  return rows.filter(
    (row) =>
      // A restricted title is hidden, so it mustn't be searchable either.
      (!q || (!row.restricted && row.title.toLowerCase().includes(q))) &&
      (filters.type === "any" || row.type === filters.type) &&
      // An unknown date can't be shown to fall in a range, so a date filter drops it.
      (since === null || activityTime(row) >= since) &&
      (filters.docs === "any" || docBucket(row.documentCount) === filters.docs) &&
      (!filters.favouritesOnly || row.favourite),
  );
}
