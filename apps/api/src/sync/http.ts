import { type FetchLike, ProviderError } from "./types.js";

export interface HttpOptions {
  fetch: FetchLike;
  /** Test seam so retries don't wait for real. */
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Maps vendor status codes onto the few outcomes the engine reacts to. */
export function errorFor(res: Response, body: string): ProviderError {
  const retry = Number(res.headers.get("retry-after"));
  const retryAfterMs = Number.isFinite(retry) && retry > 0 ? retry * 1000 : 0;
  const text = body.slice(0, 300);
  if (res.status === 401) return new ProviderError("TOKEN_EXPIRED", text, 401);
  if (res.status === 410) return new ProviderError("CHANGE_TOKEN_INVALID", text, 410);
  if (res.status === 403 || res.status === 404) {
    // Drive answers 403 with reason rateLimitExceeded when it means "slow down".
    if (res.status === 403 && /rateLimitExceeded|userRateLimitExceeded/.test(body)) {
      return new ProviderError("RATE_LIMITED", text, 403, retryAfterMs);
    }
    return new ProviderError("ACCESS_REVOKED", text, res.status);
  }
  if (res.status === 429 || res.status === 503) {
    return new ProviderError("RATE_LIMITED", text, res.status, retryAfterMs);
  }
  return new ProviderError("UPSTREAM", `${res.status} ${text}`, res.status);
}

/** GET/POST with the bearer token; retries throttling with backoff, honouring Retry-After. */
export async function call(
  http: HttpOptions,
  url: string,
  token: string,
  init: RequestInit = {},
): Promise<Response> {
  const sleep = http.sleep ?? realSleep;
  const attempts = http.maxAttempts ?? 4;
  for (let attempt = 1; ; attempt++) {
    const res = await http.fetch(url, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${token}` },
    });
    if (res.ok) return res;
    const err = errorFor(res, await res.text().catch(() => ""));
    if (err.code === "RATE_LIMITED" && attempt < attempts) {
      await sleep(err.retryAfterMs || Math.min(30_000, 500 * 2 ** (attempt - 1)));
      continue;
    }
    throw err;
  }
}

export async function json<T>(
  http: HttpOptions,
  url: string,
  token: string,
  init?: RequestInit,
): Promise<T> {
  return (await (await call(http, url, token, init)).json()) as T;
}

/** The OAuth token endpoint: form post, no bearer. invalid_grant means access was withdrawn. */
export async function tokenRequest(
  http: HttpOptions,
  url: string,
  form: Record<string, string>,
): Promise<{ access_token: string; refresh_token?: string; expires_in: number }> {
  const res = await http.fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    if (/invalid_grant|AADSTS70008|AADSTS700082|interaction_required/.test(text)) {
      throw new ProviderError("AUTH_REVOKED", "The connection was revoked.", res.status);
    }
    throw new ProviderError("UPSTREAM", `token endpoint ${res.status}`, res.status);
  }
  return JSON.parse(text);
}
