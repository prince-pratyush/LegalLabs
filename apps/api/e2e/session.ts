import pg from "pg";
import { afterAll, beforeAll, expect } from "vitest";
// @ts-expect-error: a plain script, shared with `node e2e/stack.mjs`.
import { startStack } from "./stack.mjs";

interface Stack {
  url: string;
  workspace: string;
  email: string;
  password: string;
  ownerUrl: string;
  serverEnv: Record<string, string>;
  stop: () => Promise<void>;
}

export type Event = { event: string; id: number; data: Record<string, unknown> };

/** One request never hangs a step: well under the e2e testTimeout. */
const REQUEST_MS = 2 * 60_000;
/** How long `until` polls by default; also under the testTimeout. */
const POLL_MS = 5 * 60_000;

// A signal skips afterAll, which would leave stacks running; one handler stops them all.
const running = new Set<Stack>();
let handlersSet = false;
function stopOnSignal() {
  if (handlersSet) return;
  handlersSet = true;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void Promise.allSettled([...running].map((s) => s.stop())).finally(() => process.exit(1));
    });
  }
}

/** A clean stack for this test file, signed in as its admin, and helpers to drive the API. */
export function useStack(
  options: { env?: Record<string, string>; log?: (line: string) => void } = {},
) {
  let stack: Stack | undefined;
  let cookie = "";
  stopOnSignal();

  beforeAll(async () => {
    stack = (await startStack(options)) as Stack;
    running.add(stack);
    const res = await fetch(`${stack.url}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspace: stack.workspace,
        email: stack.email,
        password: stack.password,
      }),
      signal: AbortSignal.timeout(REQUEST_MS),
    });
    expect(res.status).toBe(200);
    cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  }, 180_000);

  afterAll(async () => {
    if (!stack) return;
    running.delete(stack);
    await stack.stop();
  });

  const call = async (path: string, init: RequestInit = {}) =>
    fetch(`${stack?.url}${path}`, {
      signal: AbortSignal.timeout(REQUEST_MS),
      ...init,
      headers: {
        cookie,
        ...(typeof init.body === "string" ? { "content-type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
    });
  const json = async <T>(path: string, init: RequestInit = {}, status = 200): Promise<T> => {
    const res = await call(path, init);
    if (res.status !== status) throw new Error(`${path}: ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  };
  const post = <T>(path: string, body: unknown, status = 200) =>
    json<T>(path, { method: "POST", body: JSON.stringify(body) }, status);

  // Reads the run's event stream to its end, as the browser does.
  async function events(runId: string): Promise<Event[]> {
    const res = await call(`/api/v1/runs/${runId}/events`);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    return text
      .split("\n\n")
      .filter((block) => block.includes("event:"))
      .map((block) => {
        const field = (name: string) =>
          block
            .split("\n")
            .find((line) => line.startsWith(`${name}:`))
            ?.slice(name.length + 1)
            .trim() ?? "";
        return {
          event: field("event"),
          id: Number(field("id")),
          data: JSON.parse(field("data") || "{}"),
        };
      });
  }

  /** Runs one query as the database owner, for what the API never shows (the audit trail). */
  async function asOwner<T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) {
    const client = new pg.Client({ connectionString: stack?.ownerUrl });
    await client.connect();
    try {
      return (await client.query<T>(sql, params)).rows;
    } finally {
      await client.end();
    }
  }

  const workspace = () => stack?.workspace ?? "";

  /** What the server was started with, for a second one that differs. */
  const serverEnv = () => stack?.serverEnv ?? {};

  return { call, json, post, events, asOwner, workspace, serverEnv };
}

export async function until<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  what: string,
  ms = POLL_MS,
) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
