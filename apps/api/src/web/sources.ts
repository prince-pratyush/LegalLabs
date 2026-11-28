import {
  type SourceSelection,
  type SourceSummary,
  WEB_QUERY_CHARS,
  WEB_SOURCE_ID,
  type WebSearchSettings,
  WebSourceFilter,
  webSearchNotice,
} from "@legallabs/contracts";
import { chunkText } from "@legallabs/knowledge";
import type pg from "pg";
import { audit } from "../auth/audit.js";
import type { Client, Principal } from "../auth/auth.js";
import { sanitiseToolOutput, storable, stripInvisible } from "../connectors/sanitise.js";
import { asApp, asWorker } from "../db.js";
import type { FetchRefusal, PageFetcher, WebPage } from "./fetcher.js";
import type { SearchResult, WebSearchProvider } from "./port.js";

/*
 * Web search as a thread source. What a person typed leaves for the search service only when
 * the operator has set one up, an administrator has turned it on and no matter involved is kept
 * from it. Nothing else of theirs is ever sent, and nothing a model or a page says is searched
 * for or fetched.
 */

export interface WebPassage {
  url: string;
  title: string;
  fetchedAt: Date;
  /** The parts of the page shown to the model, marked where they read like instructions. */
  text: string;
}

/** What a turn may reach, for the matter restrictions. */
export interface WebScope {
  threadId?: string | null;
  matterIds?: readonly (string | null)[];
  documentIds?: readonly string[];
  vaultIds?: readonly string[];
}

export type WebOutcome =
  | { status: "ok"; passages: WebPassage[] }
  | { status: "failed" }
  | { status: "skipped" };

export interface WebSearchInput {
  threadId: string;
  runId: string;
  /** From `webQuery`: the typed words and nothing else. */
  query: string;
  filter?: SourceSelection["filter"];
  /** Characters of the prompt the pages may take. */
  budgetChars: number;
  client: Client;
  signal?: AbortSignal;
}

export type WebAdminResult = "ok" | "FORBIDDEN" | "NOT_CONFIGURED" | "NOT_FOUND";

export interface WebSources {
  /** The picker's entry, or null where this person may not search the web. */
  offer(principal: Principal, matterId?: string | null): Promise<SourceSummary | null>;
  /** Whether a turn asking for these may go ahead. */
  allowed(
    principal: Principal,
    scope: WebScope,
    filter?: SourceSelection["filter"],
  ): Promise<boolean>;
  search(principal: Principal, input: WebSearchInput): Promise<WebOutcome>;
  /** The stored text of a page this run read, while it is kept. */
  page(principal: Principal, runId: string, url: string): Promise<string | null>;
  settings(principal: Principal): Promise<WebSearchSettings>;
  setEnabled(principal: Principal, enabled: boolean, client: Client): Promise<WebAdminResult>;
  setMatter(
    principal: Principal,
    matterId: string,
    blocked: boolean,
    client: Client,
  ): Promise<WebAdminResult>;
  /** Removes pages past their day. */
  purge(): Promise<void>;
}

const RESULTS = 8;
const PAGES = 5;
const SEARCH_MS = 10_000;
const WINDOW = 1200;
const WINDOWS_PER_PAGE = 2;
const MAX_PASSAGES_CHARS = 12_000;
const MAX_URL = 2000;

/** The typed words alone. A mention's label is a file or vault name, so it never goes. */
export function webQuery(blocks: readonly { type: string; text?: string }[]): string {
  const typed = blocks.map((b) => (b.type === "text" ? (b.text ?? "") : " ")).join("");
  const line = stripInvisible(typed).replace(/\s+/g, " ").trim();
  return storable(line.slice(0, WEB_QUERY_CHARS)).trim();
}

/** The parts of a page that share most words with the question, in page order. */
function excerpt(text: string, query: string): string {
  const words = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])].slice(0, 40);
  const windows = chunkText(text, null, WINDOW).map((chunk, at) => {
    const lower = chunk.text.toLowerCase();
    return { at, text: chunk.text, score: words.filter((word) => lower.includes(word)).length };
  });
  return windows
    .sort((a, b) => b.score - a.score || a.at - b.at)
    .slice(0, WINDOWS_PER_PAGE)
    .sort((a, b) => a.at - b.at)
    .map((w) => w.text)
    .join("\n...\n");
}

type Db = pg.PoolClient;

export function createWebSources(
  pool: pg.Pool,
  deps: { provider: WebSearchProvider | null; fetcher: PageFetcher },
): WebSources {
  const { provider, fetcher } = deps;

  const switchedOn = async (db: Db) => {
    const { rows } = await db.query<{ on: boolean }>(
      `select core.has_permission('threads.use')
          and coalesce((select enabled from work.web_settings), false) "on"`,
    );
    return rows[0]?.on === true;
  };

  /** True when any matter this turn touches is kept from web search. */
  const blocked = async (db: Db, scope: WebScope) => {
    const { rows } = await db.query<{ blocked: boolean }>(
      `with touched as (
         select unnest($2::uuid[]) matter_id
         union select t.matter_id from work.thread t where t.id = $1::uuid
         union select d.matter_id from content.document d where d.id = any ($3::uuid[])
         union select d.matter_id from work.thread_document td
                  join content.document_version v on v.id = td.version_id
                  join content.document d on d.id = v.document_id
                 where td.thread_id = $1::uuid
         union select d.matter_id from work.thread t
                  join content.document d on d.id = any (t.source_documents)
                 where t.id = $1::uuid
         union select v.matter_id from content.vault v
                where v.id = any ($4::uuid[])
                   or v.id = any (select unnest(t.vault_ids) from work.thread t
                                   where t.id = $1::uuid))
       select exists (select 1 from work.web_blocked_matter b
                        join touched using (matter_id)) blocked`,
      [
        scope.threadId ?? null,
        (scope.matterIds ?? []).filter((id) => id !== null),
        scope.documentIds ?? [],
        scope.vaultIds ?? [],
      ],
    );
    return rows[0]?.blocked !== false;
  };

  const may = (db: Db, scope: WebScope) =>
    switchedOn(db).then(async (on) => on && !(await blocked(db, scope)));

  const allowed: WebSources["allowed"] = async (principal, scope, filter) => {
    if (!provider || !WebSourceFilter.safeParse(filter ?? {}).success) return false;
    return asApp(pool, principal, (db) => may(db, scope));
  };

  return {
    allowed,

    async offer(principal, matterId = null) {
      if (!provider || !(await allowed(principal, { matterIds: [matterId] }))) return null;
      return {
        id: WEB_SOURCE_ID,
        name: "Web search",
        kind: "web",
        notice: webSearchNotice(provider.host),
      };
    },

    async search(principal, input) {
      const { threadId, runId, query, client } = input;
      const filter = WebSourceFilter.safeParse(input.filter ?? {});
      if (!provider || !filter.success || !query) return { status: "skipped" };
      // Asked again here, so a switch thrown since the question was accepted still holds. The
      // record is written before anything leaves, so a crash cannot hide that it did.
      const go = await asApp(pool, principal, async (db) => {
        if (!(await may(db, { threadId }))) return false;
        await audit(db, principal, client, "web.search.sent", "thread", threadId, {
          run_id: runId,
          provider: provider.name,
          query_chars: query.length,
        });
        return true;
      });
      if (!go) return { status: "skipped" };

      const stop = (ms: number) =>
        input.signal
          ? AbortSignal.any([input.signal, AbortSignal.timeout(ms)])
          : AbortSignal.timeout(ms);
      let results: SearchResult[];
      try {
        results = await provider.search(query, {
          limit: RESULTS,
          ...(filter.data.recency_days ? { recencyDays: filter.data.recency_days } : {}),
          signal: stop(SEARCH_MS),
        });
      } catch (err) {
        // The name only: a message could repeat the query.
        console.warn(`web search failed: ${err instanceof Error ? err.name : "unknown"}`);
        return { status: "failed" };
      }

      const fetched = await Promise.all(
        results.slice(0, PAGES).map(async (result) => ({
          result,
          got: await fetcher.fetch(result.url, input.signal ? { signal: input.signal } : {}),
        })),
      );
      const refused: Partial<Record<FetchRefusal, number>> = {};
      const read = new Map<string, WebPage>();
      for (const { result, got } of fetched) {
        if (!got.ok) {
          refused[got.reason] = (refused[got.reason] ?? 0) + 1;
          continue;
        }
        const { page } = got;
        if (!page.url.startsWith("https://") || page.url.length > MAX_URL) continue;
        const title = storable((page.title || result.title).slice(0, 300));
        if (!read.has(page.url)) read.set(page.url, { ...page, title });
      }

      await asApp(pool, principal, async (db) => {
        for (const page of read.values()) {
          await db.query(
            `insert into work.web_fetch_cache (workspace_id, run_id, url, title, text, fetched_at)
             values ($1, $2, $3, $4, $5, $6) on conflict do nothing`,
            [principal.workspaceId, runId, page.url, page.title, page.text, page.fetchedAt],
          );
        }
        await audit(db, principal, client, "web.pages.fetched", "thread", threadId, {
          run_id: runId,
          results: results.length,
          fetched: read.size,
          refused,
          domains: [...new Set([...read.keys()].map((url) => new URL(url).hostname))],
        });
      });

      let room = Math.min(input.budgetChars, MAX_PASSAGES_CHARS);
      const passages: WebPassage[] = [];
      for (const page of read.values()) {
        const text = sanitiseToolOutput(excerpt(page.text, query), room).text;
        if (text.length > room) break;
        room -= text.length;
        passages.push({ url: page.url, title: page.title, fetchedAt: page.fetchedAt, text });
      }
      return { status: "ok", passages };
    },

    async page(principal, runId, url) {
      return asApp(pool, principal, async (db) => {
        const { rows } = await db.query<{ text: string }>(
          `select text from work.web_fetch_cache
            where run_id = $1 and url = $2 and expires_at > now()`,
          [runId, url],
        );
        return rows[0]?.text ?? null;
      });
    },

    async settings(principal) {
      return asApp(pool, principal, async (db) => {
        const { rows } = await db.query<{ enabled: boolean; manage: boolean }>(
          `select coalesce((select enabled from work.web_settings), false) enabled,
                  core.has_permission('admin.config') manage`,
        );
        const manage = rows[0]?.manage === true;
        const kept = manage
          ? await db.query<{ matter_id: string }>(
              "select matter_id from work.web_blocked_matter order by created_at, matter_id",
            )
          : { rows: [] };
        return {
          configured: provider !== null,
          enabled: rows[0]?.enabled === true,
          provider_host: provider?.host ?? null,
          can_manage: manage,
          blocked_matter_ids: kept.rows.map((r) => r.matter_id),
        };
      });
    },

    async setEnabled(principal, enabled, client) {
      return asApp(pool, principal, async (db) => {
        const { rows } = await db.query<{ ok: boolean }>(
          "select core.has_permission('admin.config') ok",
        );
        if (!rows[0]?.ok) return "FORBIDDEN";
        // Turning it off is always allowed.
        if (enabled && !provider) return "NOT_CONFIGURED";
        await db.query(
          `insert into work.web_settings (workspace_id, enabled) values ($1, $2)
           on conflict (workspace_id) do update set enabled = $2, updated_at = now()`,
          [principal.workspaceId, enabled],
        );
        await audit(
          db,
          principal,
          client,
          "web.search.settings_updated",
          "workspace",
          principal.workspaceId as string,
          { enabled },
        );
        return "ok";
      });
    },

    async setMatter(principal, matterId, keep, client) {
      return asApp(pool, principal, async (db) => {
        const { rows } = await db.query<{ ok: boolean; found: boolean }>(
          `select core.has_permission('admin.config') ok,
                  exists (select 1 from core.matter where id = $1) found`,
          [matterId],
        );
        if (!rows[0]?.ok) return "FORBIDDEN";
        if (!rows[0].found) return "NOT_FOUND";
        await db.query(
          keep
            ? `insert into work.web_blocked_matter (workspace_id, matter_id) values ($1, $2)
               on conflict do nothing`
            : "delete from work.web_blocked_matter where workspace_id = $1 and matter_id = $2",
          [principal.workspaceId, matterId],
        );
        await audit(db, principal, client, "web.search.matter_updated", "matter", matterId, {
          blocked: keep,
        });
        return "ok";
      });
    },

    async purge() {
      await asWorker(pool, (db) => db.query("select work.purge_web_fetch_cache()"));
    },
  };
}
