import { ApiError, FALLBACK } from "../api.js";

/** One JSON (or multipart, or 204) call under /api/v1; failures become an ApiError with the server's words. */
export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const json = typeof init.body === "string";
  const res = await fetch(`/api/v1${path}`, {
    ...init,
    credentials: "same-origin",
    headers: { ...(json ? { "content-type": "application/json" } : {}), ...init.headers },
  });
  const text = await res.text();
  let body: Record<string, unknown> | null = null;
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    throw new ApiError(
      res.status,
      String(body?.code ?? body?.error ?? "UNKNOWN"),
      typeof body?.message === "string" ? body.message : FALLBACK,
    );
  }
  return body as T;
}

export const send = <T>(method: string, path: string, body?: unknown) =>
  request<T>(path, body === undefined ? { method } : { method, body: JSON.stringify(body) });
