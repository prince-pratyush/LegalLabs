import type { HistoryFilters, HistoryRow } from "@legallabs/ui";
import type { HistoryItem, HistoryQuery } from "../api.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const DAYS = { "7d": 7, "30d": 30, "90d": 90 } as const;

/** The table's filters as the server's query; null when the server can't answer it. */
export function historyQuery(filters: HistoryFilters, now: Date): HistoryQuery | null {
  // Drafts aren't threads the history endpoint knows about yet.
  if (filters.type === "draft") return null;
  const query: HistoryQuery = {};
  const q = filters.search.trim();
  if (q) query.q = q;
  if (filters.type !== "any") query.type = filters.type;
  if (filters.date !== "any") {
    query.from = new Date(now.getTime() - DAYS[filters.date] * DAY_MS).toISOString();
  }
  if (filters.docs !== "any") query.docs = filters.docs;
  if (filters.favouritesOnly) query.favourites = true;
  return query;
}

export const toRow = (item: HistoryItem): HistoryRow => ({
  id: item.id,
  title: item.title,
  type: item.type,
  // Only the id comes back, and an id means nothing to a reader.
  matter: item.matter_id ? "In a matter" : null,
  documentCount: item.document_count,
  model: item.model,
  costUsd: item.cost_usd,
  lastActivityAt: item.last_activity_at,
  status: item.status,
  favourite: item.favourite,
  restricted: false,
});
