import { act, cleanup, configure } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";
import type { Citation, Message, Run, Thread } from "./api.js";

// The first render loads the whole design system, which is slow in jsdom.
configure({ asyncUtilTimeout: 5000 });

export const DOC = "0190a000-0000-7000-8000-000000000001";
export const THREAD_ID = "0190a000-0000-7000-8000-000000000003";
export const RUN_ID = "0190a000-0000-7000-8000-000000000009";

export const source = (n: number, at: number, status: Citation["status"]): Citation => ({
  n,
  at,
  kind: "document",
  document_id: status === "unresolved" ? null : DOC,
  version_id: status === "unresolved" ? null : "v",
  version_no: status === "unresolved" ? null : 1,
  document_name: status === "unresolved" ? null : "msa.pdf",
  page: 3,
  quote: `quote ${n}`,
  char_from: status === "ok" ? 0 : null,
  char_to: status === "ok" ? 7 : null,
  status,
  authority: null,
  open_url: status === "ok" ? `/d/${DOC}/v/1?p=3&cf=0&ct=7` : null,
});

export const message = (
  over: Partial<Message> & Pick<Message, "id" | "role" | "content">,
): Message => ({
  model: null,
  requested_model: null,
  fallback: false,
  input_tokens: null,
  output_tokens: null,
  cost_usd: null,
  ungrounded: [],
  created_at: "2026-11-10T00:00:00.000Z",
  citations: [],
  ...over,
});

export const CONTENT = "The cap is <img src=x onerror=alert(1)> one. Two. Three.";
export const QUESTION = message({ id: "m1", role: "user", content: "What is the cap?" });
export const ANSWER = message({
  id: "m2",
  role: "assistant",
  content: CONTENT,
  model: "anthropic/claude-haiku-5-5",
  input_tokens: 1200,
  output_tokens: 300,
  cost_usd: 0.01,
  citations: [
    source(1, CONTENT.indexOf(" one.") + 4, "ok"),
    source(2, CONTENT.indexOf(" Two") + 4, "mismatch"),
    source(3, CONTENT.indexOf(" Three") + 6, "unresolved"),
  ],
});

export const run = (status: Run["status"], messageId: string | null = null): Run => ({
  id: RUN_ID,
  kind: "thread",
  status,
  thread_id: THREAD_ID,
  question_id: "m1",
  message_id: messageId,
  coverage: null,
  plan: null,
  model: null,
  cost_usd: 0,
});

export const thread = (over: Partial<Thread> = {}): Thread => ({
  id: THREAD_ID,
  title: "What is the cap?",
  matter_id: null,
  created_at: "2026-11-10T00:00:00.000Z",
  read_only: false,
  vault_ids: [],
  sources: [],
  documents: [
    {
      id: DOC,
      version_id: "v",
      version_no: 1,
      name: "msa.pdf",
      page_count: 10,
      empty_page_count: 0,
    },
  ],
  messages: [QUESTION, ANSWER],
  runs: [run("done", "m2")],
  ...over,
});

export type Handler = (body: unknown) => [number, unknown];

// Answers the page's requests from a table, and records what it was sent.
export function serve(routes: Record<string, Handler>) {
  const sent: { route: string; body: unknown }[] = [];
  const fetch = vi.fn(async (input: string, init?: RequestInit) => {
    const route = `${init?.method ?? "GET"} ${input}`;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
    sent.push({ route, body });
    const handler = routes[route];
    const [status, json] = handler ? handler(body) : [404, { code: "NOT_FOUND", message: "No." }];
    return new Response(status === 204 ? null : JSON.stringify(json), {
      status,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetch);
  return sent;
}

// Stands in for the browser's EventSource, so a test can play a run's events.
export class FakeSource {
  static all: FakeSource[] = [];
  readyState = 1;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, ((event: MessageEvent) => void)[]>();
  constructor(readonly url: string) {
    FakeSource.all.push(this);
  }
  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close() {
    this.readyState = 2;
  }
  emit(type: string, seq: number, data: object) {
    const event = new MessageEvent(type, {
      data: JSON.stringify({ seq, ...data }),
      lastEventId: String(seq),
    });
    act(() => {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    });
  }
}

export const SCOPE = { vaults: [], sources: [], models: [] };
export const signedIn: Record<string, Handler> = {
  "GET /auth/session": () => [200, { user_id: "u", workspace_id: "w" }],
  "GET /api/v1/history": () => [200, { items: [], next_cursor: null }],
  "GET /api/v1/scope-options": () => [200, SCOPE],
};

export const at = (hash: string) => {
  window.location.hash = hash;
};

// jsdom has no layout, but Radix and the table measure through this.
export class NoResize {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  FakeSource.all = [];
  vi.stubGlobal("EventSource", FakeSource);
  vi.stubGlobal("ResizeObserver", NoResize);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = "";
});
