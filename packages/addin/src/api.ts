/** A failed call, with the API's error code so the pane can say what to do next. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Words for the user: the API's own message when there is one. */
export const messageOf = (err: unknown) =>
  err instanceof ApiError ? err.message : "Something went wrong. Try again.";

export interface Api {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  upload<T>(path: string, form: FormData): Promise<T>;
}

/** The API with the one call only a stream-reading pane needs. */
export interface StreamingApi extends Api {
  /** Reads a server-sent event stream to its end. EventSource can't send the token. */
  events(path: string, on: (type: string, data: unknown) => void): Promise<void>;
}

type Fetch = typeof fetch;

// One event is the lines up to a blank one; comments keep the connection open.
function dispatch(block: string, on: (type: string, data: unknown) => void) {
  let type = "message";
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) type = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  if (data.length === 0) return;
  try {
    on(type, JSON.parse(data.join("\n")));
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
  }
}

async function failure(res: Response): Promise<ApiError> {
  const body = (await res.json().catch(() => null)) as {
    code?: string;
    error?: string;
    message?: string;
  } | null;
  const code = body?.code ?? body?.error ?? `HTTP_${res.status}`;
  const message =
    body?.message ??
    (res.status === 404 ? "This server doesn't offer that yet." : "Something went wrong.");
  return new ApiError(res.status, code, message);
}

/**
 * Same origin as the pane, with the session token as a bearer header: Word on the web
 * frames the pane, where the web app's cookie isn't sent.
 */
export function createApi(
  token: () => string | null,
  onUnauthorized: () => void = () => {},
  fetchImpl: Fetch = (input, init) => fetch(input, init),
  /** Names the pane, so its use is counted as its own; the server grants nothing for it. */
  client?: "outlook",
): StreamingApi {
  const request = async (path: string, init: RequestInit): Promise<Response> => {
    const headers = new Headers(init.headers);
    const current = token();
    if (current) headers.set("authorization", `Bearer ${current}`);
    if (client) headers.set("x-legallabs-client", client);
    const res = await fetchImpl(path, { ...init, headers, credentials: "omit" });
    if (res.status === 401) onUnauthorized();
    if (!res.ok) throw await failure(res);
    return res;
  };
  const send = async <T>(path: string, init: RequestInit): Promise<T> => {
    const res = await request(path, init);
    return (res.status === 204 ? null : await res.json()) as T;
  };

  return {
    get: (path) => send(path, { method: "GET" }),
    post: (path, body) =>
      send(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
      }),
    upload: (path, form) => send(path, { method: "POST", body: form }),
    async events(path, on) {
      const res = await request(path, { method: "GET" });
      const reader = res.body?.getReader();
      if (!reader) return;
      const decoder = new TextDecoder();
      let waiting = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        waiting += decoder.decode(value, { stream: true }).replaceAll("\r", "");
        const blocks = waiting.split("\n\n");
        waiting = blocks.pop() ?? "";
        for (const block of blocks) dispatch(block, on);
      }
    },
  };
}
