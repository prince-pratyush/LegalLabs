/** An honest, generic name; each source's terms ask callers to say who they are. */
export const DEFAULT_USER_AGENT =
  "LegalLabs-knowledge/0.1 (+https://github.com/prince-pratyush/LegalLabs)";

export class SourceUnavailable extends Error {}
export class NotFound extends Error {}

export interface HttpOptions {
  userAgent?: string;
  /** Requests per second this client keeps under. */
  perSecond: number;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
  headers?: Record<string, string>;
}

export interface Http {
  text(url: string, headers?: Record<string, string>): Promise<string>;
  json(url: string, headers?: Record<string, string>): Promise<unknown>;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** One client per source: spaced requests, backoff on 429 and 5xx, https only, size-capped. */
export function createHttp(options: HttpOptions): Http {
  const send = options.fetch ?? fetch;
  const sleep = options.sleep ?? wait;
  const gap = 1000 / options.perSecond;
  const maxBytes = options.maxBytes ?? 20 * 1024 * 1024;
  const retries = options.retries ?? 3;
  let next = 0;

  async function get(url: string, headers: Record<string, string> = {}): Promise<string> {
    if (!url.startsWith("https://")) throw new SourceUnavailable("only https sources are fetched");
    for (let attempt = 0; ; attempt++) {
      const now = Date.now();
      const start = Math.max(now, next);
      next = start + gap;
      if (start > now) await sleep(start - now);
      let res: Response;
      try {
        res = await send(url, {
          headers: {
            "user-agent": options.userAgent ?? DEFAULT_USER_AGENT,
            ...options.headers,
            ...headers,
          },
          redirect: "follow",
          signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
        });
      } catch (err) {
        if (attempt < retries) {
          await sleep(2 ** attempt * 1000);
          continue;
        }
        throw new SourceUnavailable(err instanceof Error ? err.name : "fetch failed");
      }
      if (res.status === 404) {
        await res.body?.cancel();
        throw new NotFound(url);
      }
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        await res.body?.cancel();
        const after = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(after) && after > 0 ? after * 1000 : 2 ** attempt * 1000);
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel();
        throw new SourceUnavailable(`${new URL(url).host} answered ${res.status}`);
      }
      if (Number(res.headers.get("content-length")) > maxBytes) {
        await res.body?.cancel();
        throw new SourceUnavailable("response too large");
      }
      const body = await res.text();
      if (body.length > maxBytes) throw new SourceUnavailable("response too large");
      return body;
    }
  }

  return {
    text: get,
    async json(url, headers) {
      const body = await get(url, { accept: "application/json", ...headers });
      try {
        return JSON.parse(body) as unknown;
      } catch {
        throw new SourceUnavailable(`${new URL(url).host} sent invalid JSON`);
      }
    },
  };
}
