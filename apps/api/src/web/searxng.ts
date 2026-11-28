import { storable, stripInvisible } from "../connectors/sanitise.js";
import { safeRequest } from "../net/fetch.js";
import { USER_AGENT } from "./fetcher.js";
import type { SearchResult, WebSearchProvider } from "./port.js";

const DEADLINE_MS = 10_000;
const MAX_BYTES = 2_000_000;
const MAX_URL = 2000;

const text = (value: unknown, max: number) =>
  typeof value === "string"
    ? storable(stripInvisible(value).replace(/\s+/g, " ").trim().slice(0, max))
    : "";

function results(body: unknown, limit: number): SearchResult[] {
  const listed = (body as { results?: unknown } | null)?.results;
  if (!Array.isArray(listed)) throw new Error("the search service sent no results list");
  const kept = new Map<string, SearchResult>();
  for (const item of listed as Record<string, unknown>[]) {
    if (kept.size >= limit) break;
    const raw = item?.url;
    if (typeof raw !== "string" || raw.length > MAX_URL || !URL.canParse(raw)) continue;
    const url = new URL(raw);
    url.hash = "";
    if (url.protocol !== "https:" || kept.has(url.href)) continue;
    const published = text(item.publishedDate, 40);
    kept.set(url.href, {
      url: url.href,
      title: text(item.title, 300),
      snippet: text(item.content, 1000),
      ...(published ? { publishedAt: published } : {}),
    });
  }
  return [...kept.values()];
}

const range = (days: number) =>
  days <= 1 ? "day" : days <= 31 ? "month" : days <= 366 ? "year" : null;

export interface SearxngOptions {
  /** The service's base address, set by the operator. */
  url: string;
  /** Lets this one origin be plain http or on a private network. Page fetches never are. */
  allowInternal?: boolean;
}

/** A SearXNG instance, or anything answering its JSON search. */
export function createSearxng({ url, allowInternal = false }: SearxngOptions): WebSearchProvider {
  const endpoint = new URL("search", url.endsWith("/") ? url : `${url}/`);
  return {
    name: "searxng",
    host: endpoint.host,
    async search(query, { limit, recencyDays, signal }) {
      const form = new URLSearchParams({ q: query, format: "json", safesearch: "1" });
      const since = recencyDays === undefined ? null : range(recencyDays);
      if (since) form.set("time_range", since);
      // Posted, so the query stays out of access logs along the way.
      const res = await safeRequest(
        endpoint.href,
        {
          deadlineMs: DEADLINE_MS,
          timeoutMs: DEADLINE_MS,
          maxBytes: MAX_BYTES,
          ...(allowInternal ? { trustedOrigin: endpoint.origin } : {}),
        },
        {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/x-www-form-urlencoded",
            "user-agent": USER_AGENT,
          },
          body: form.toString(),
          ...(signal ? { signal } : {}),
        },
      );
      if (res.status !== 200) throw new Error(`the search service answered ${res.status}`);
      let body: unknown;
      try {
        body = JSON.parse(res.body);
      } catch {
        throw new Error("the search service did not send JSON");
      }
      return results(body, limit);
    },
  };
}

/**
 * Reads the search service from the environment; null, and web search is off, when unset.
 *
 * LEGALLABS_SEARXNG_URL       base address of a SearXNG-compatible service
 * LEGALLABS_SEARXNG_INTERNAL  true when that service is plain http or on a private network
 *
 * A half-set or unsafe configuration throws.
 */
export function webSearchFromEnv(env: NodeJS.ProcessEnv): WebSearchProvider | null {
  const url = env.LEGALLABS_SEARXNG_URL;
  const internal = env.LEGALLABS_SEARXNG_INTERNAL || "false";
  if (internal !== "true" && internal !== "false") {
    throw new Error("LEGALLABS_SEARXNG_INTERNAL must be true or false");
  }
  if (!url) {
    if (internal === "true") {
      throw new Error("LEGALLABS_SEARXNG_INTERNAL is set without LEGALLABS_SEARXNG_URL");
    }
    return null;
  }
  const parsed = URL.canParse(url) ? new URL(url) : null;
  const scheme =
    parsed?.protocol === "https:" || (internal === "true" && parsed?.protocol === "http:");
  if (!parsed || !scheme) {
    throw new Error("LEGALLABS_SEARXNG_URL must be an https address (http only when internal)");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("LEGALLABS_SEARXNG_URL takes no credentials, query or fragment");
  }
  return createSearxng({ url, allowInternal: internal === "true" });
}
