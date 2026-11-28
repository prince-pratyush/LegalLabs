import { storable, stripInvisible } from "../connectors/sanitise.js";
import { BlockedFetch, safeDownload } from "../net/fetch.js";
import { MAX_TEXT, readPage } from "./extract.js";
import { robotsAllow } from "./robots.js";

/*
 * Fetches one web page so it can be quoted. The address was chosen by a search provider, a
 * page or a person, so it is hostile until shown otherwise: https on the usual port, public
 * addresses only on every hop, no cookies or credentials, one deadline, a size cap, text types
 * only, and the site's robots.txt is obeyed. What comes back is untrusted text.
 */

export type FetchRefusal =
  | "SSRF_BLOCKED"
  | "NOT_ALLOWED_URL"
  | "ROBOTS_DISALLOWED"
  | "TOO_LARGE"
  | "TOO_MANY_REDIRECTS"
  | "UNSUPPORTED_TYPE"
  | "HTTP_ERROR"
  | "TIMEOUT"
  | "UNREACHABLE"
  | "EMPTY";

export interface WebPage {
  /** Where the text came from, after redirects. */
  url: string;
  title: string;
  text: string;
  fetchedAt: Date;
}

export type FetchedPage = { ok: true; page: WebPage } | { ok: false; reason: FetchRefusal };

export interface PageFetcher {
  /** Never throws: a page that cannot be had is a reason. */
  fetch(url: string, options?: { signal?: AbortSignal }): Promise<FetchedPage>;
}

export interface FetcherOptions {
  /** Tests only: plain http, any port and private addresses. */
  insecureDev?: boolean;
  /** For the whole fetch: robots.txt, redirects and the page. */
  deadlineMs?: number;
  maxBytes?: number;
  /** Told when an address is refused as unsafe. The host only: a path can carry facts. */
  onRefused?: (reason: "SSRF_BLOCKED", host: string) => void;
  now?: () => Date;
}

export const USER_AGENT = "LegalLabs/1.0";
const MAX_URL = 2000;
const MAX_REDIRECTS = 3;
const ROBOTS_BYTES = 500_000;
const TYPES = new Set(["text/html", "application/xhtml+xml", "text/plain"]);
// No compression is asked for, so there is nothing to expand past the size cap.
const HEADERS = {
  "user-agent": USER_AGENT,
  accept: "text/html, application/xhtml+xml, text/plain",
  "accept-encoding": "identity",
};

class Refused extends Error {
  constructor(readonly reason: FetchRefusal) {
    super(reason);
  }
}

function refusalOf(err: unknown): FetchRefusal {
  if (err instanceof Refused) return err.reason;
  if (err instanceof BlockedFetch) {
    if (err.code === "url") return "NOT_ALLOWED_URL";
    if (err.code === "size") return "TOO_LARGE";
    if (err.code === "redirects") return "TOO_MANY_REDIRECTS";
    return "SSRF_BLOCKED";
  }
  const message = err instanceof Error ? err.message : "";
  return /took too long|timed out/.test(message) ? "TIMEOUT" : "UNREACHABLE";
}

function decode(body: Buffer, contentType: string): string {
  const declared =
    /charset\s*=\s*"?([\w.:-]+)/i.exec(contentType)?.[1] ??
    /<meta[^>]{0,200}?charset\s*=\s*["']?([\w.:-]+)/i.exec(
      body.subarray(0, 2048).toString("latin1"),
    )?.[1];
  try {
    return new TextDecoder(declared ?? "utf-8").decode(body);
  } catch {
    return new TextDecoder().decode(body);
  }
}

export function createPageFetcher(options: FetcherOptions = {}): PageFetcher {
  const { insecureDev = false, deadlineMs = 10_000, maxBytes = 5_000_000 } = options;
  const now = options.now ?? (() => new Date());
  const onRefused =
    options.onRefused ??
    ((reason, host) => console.warn(`web fetch refused: ${reason} host=${host}`));

  return {
    async fetch(url, { signal } = {}) {
      let host = "";
      const until = Date.now() + deadlineMs;
      const robots = new Map<string, string | null>();
      const policy = { insecureDev, timeoutMs: deadlineMs };
      const init = { publicHeaders: HEADERS, ...(signal ? { signal } : {}) };

      const check = (target: URL) => {
        host = target.hostname;
        const web = target.protocol === "https:" && target.port === "";
        if ((!web && !insecureDev) || target.username || target.password) {
          throw new Refused("NOT_ALLOWED_URL");
        }
      };

      const allowed = async (target: URL, msLeft: number) => {
        let rules = robots.get(target.origin);
        if (rules === undefined) {
          const res = await safeDownload(
            `${target.origin}/robots.txt`,
            {
              ...policy,
              deadlineMs: Math.max(1, msLeft),
              maxBytes: ROBOTS_BYTES,
              maxRedirects: MAX_REDIRECTS,
              onHop: check,
            },
            init,
          );
          host = target.hostname;
          // No file means no rules; a server that cannot say is taken to mean no.
          if (res.status >= 200 && res.status < 300) rules = res.body.toString("utf8");
          else rules = res.status >= 400 && res.status < 500 ? "" : null;
          robots.set(target.origin, rules);
        }
        return rules !== null && robotsAllow(rules, `${target.pathname}${target.search}`);
      };

      try {
        if (url.length > MAX_URL || !URL.canParse(url)) throw new Refused("NOT_ALLOWED_URL");
        const first = new URL(url);
        first.hash = "";
        const res = await safeDownload(
          first.href,
          {
            ...policy,
            deadlineMs: Math.max(1, until - Date.now()),
            maxBytes,
            maxRedirects: MAX_REDIRECTS,
            onHop: async (target, msLeft) => {
              check(target);
              if (!(await allowed(target, msLeft))) throw new Refused("ROBOTS_DISALLOWED");
            },
          },
          init,
        );
        if (res.status !== 200) throw new Refused("HTTP_ERROR");
        const contentType = res.headers["content-type"] ?? "";
        const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
        const encoding = res.headers["content-encoding"] ?? "identity";
        if (!TYPES.has(type) || encoding !== "identity") throw new Refused("UNSUPPORTED_TYPE");
        const raw = decode(res.body, contentType);
        const read =
          type === "text/plain"
            ? { title: "", text: stripInvisible(storable(raw.slice(0, MAX_TEXT))).trim() }
            : readPage(raw);
        if (!read.text) throw new Refused("EMPTY");
        const final = new URL(res.url);
        final.hash = "";
        return { ok: true, page: { url: final.href, ...read, fetchedAt: now() } };
      } catch (err) {
        const reason = refusalOf(err);
        if (reason === "SSRF_BLOCKED") onRefused(reason, host);
        return { ok: false, reason };
      }
    },
  };
}
