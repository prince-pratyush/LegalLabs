import {
  act,
  cleanup,
  configure,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";
import type { Citation, Message, Run, Thread } from "./api.js";

// The first render loads the whole design system, which is slow in jsdom.
configure({ asyncUtilTimeout: 5000 });

const DOC = "0190a000-0000-7000-8000-000000000001";
const THREAD_ID = "0190a000-0000-7000-8000-000000000003";
const RUN_ID = "0190a000-0000-7000-8000-000000000009";

const source = (n: number, at: number, status: Citation["status"]): Citation => ({
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

const message = (over: Partial<Message> & Pick<Message, "id" | "role" | "content">): Message => ({
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

const CONTENT = "The cap is <img src=x onerror=alert(1)> one. Two. Three.";
const QUESTION = message({ id: "m1", role: "user", content: "What is the cap?" });
const ANSWER = message({
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

const run = (status: Run["status"], messageId: string | null = null): Run => ({
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

const thread = (over: Partial<Thread> = {}): Thread => ({
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

type Handler = (body: unknown) => [number, unknown];

// Answers the page's requests from a table, and records what it was sent.
function serve(routes: Record<string, Handler>) {
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
class FakeSource {
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

const SCOPE = { vaults: [], sources: [], models: [] };
const signedIn: Record<string, Handler> = {
  "GET /auth/session": () => [200, { user_id: "u", workspace_id: "w" }],
  "GET /api/v1/history": () => [200, { items: [], next_cursor: null }],
  "GET /api/v1/scope-options": () => [200, SCOPE],
};

const at = (hash: string) => {
  window.location.hash = hash;
};

// jsdom has no layout, but Radix and the table measure through this.
class NoResize {
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

describe("signing in", () => {
  it("signs in, then offers a new thread", async () => {
    let session = false;
    const sent = serve({
      ...signedIn,
      "GET /auth/session": () =>
        session ? [200, { user_id: "u", workspace_id: "w" }] : [401, { error: "unauthenticated" }],
      "POST /auth/login": () => {
        session = true;
        return [200, { user_id: "u", workspace_id: "w" }];
      },
    });
    render(<App />);
    fireEvent.change(await screen.findByLabelText("Workspace"), { target: { value: "acme" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ana@acme.test" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secret pass" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("heading", { name: "New thread" })).toBeTruthy();
    expect(sent.find((call) => call.route === "POST /auth/login")?.body).toEqual({
      workspace: "acme",
      email: "ana@acme.test",
      password: "secret pass",
    });
  });

  it("says when sign-in details are wrong", async () => {
    serve({
      "GET /auth/session": () => [401, { error: "unauthenticated" }],
      "POST /auth/login": () => [401, { error: "invalid_credentials" }],
    });
    render(<App />);
    fireEvent.change(await screen.findByLabelText("Workspace"), { target: { value: "acme" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ana@acme.test" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Those details didn't match an account.",
    );
  });
});

describe("a new thread", () => {
  it("won't send without something to read, and says why", async () => {
    serve(signedIn);
    render(<App />);
    const box = await screen.findByRole("textbox", { name: "Ask a question" });
    fireEvent.change(box, { target: { value: "Cap?" } });
    expect(screen.getByRole("button", { name: "Send" })).toHaveProperty("disabled", true);
    expect(screen.getByText("Attach a file, a vault or a source to ask about.")).toBeTruthy();
  });

  it("asks with a picked vault and opens the new thread", async () => {
    const sent = serve({
      ...signedIn,
      "GET /api/v1/scope-options": () => [
        200,
        { ...SCOPE, vaults: [{ id: "vault-1", name: "Leases", file_count: 3 }] },
      ],
      "POST /api/v1/threads": () => [
        202,
        { thread_id: THREAD_ID, message_id: "m1", run_id: RUN_ID },
      ],
      [`GET /api/v1/threads/${THREAD_ID}`]: () => [200, { thread: thread() }],
    });
    render(<App />);
    const box = await screen.findByRole("textbox", { name: "Ask a question" });
    // Typing a mention picks the vault and sends it as a mention block.
    fireEvent.change(box, { target: { value: "Cap in @Lea", selectionStart: 11 } });
    fireEvent.keyDown(await screen.findByRole("textbox", { name: "Ask a question" }), {
      key: "Enter",
    });
    await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe("Cap in @Leases "));
    fireEvent.change(box, { target: { value: "Cap in @Leases now?", selectionStart: 19 } });
    fireEvent.keyDown(box, { key: "Enter" });

    await waitFor(() => expect(window.location.hash).toBe(`#/t/${THREAD_ID}`));
    expect(sent.find((c) => c.route === "POST /api/v1/threads")?.body).toEqual({
      content: [
        { type: "text", text: "Cap in " },
        { type: "mention", ref_type: "vault", ref_id: "vault-1", label: "Leases" },
        { type: "text", text: " now?" },
      ],
      scope: { document_ids: [], vault_ids: [], sources: [] },
    });
    expect(await screen.findByTestId("answer-m2")).toBeTruthy();
  });
});

describe("a thread", () => {
  it("shows answers as text with each source's check, and model and cost", async () => {
    serve({ ...signedIn, [`GET /api/v1/threads/${THREAD_ID}`]: () => [200, { thread: thread() }] });
    at(`#/t/${THREAD_ID}`);
    render(<App />);
    const answer = await screen.findByTestId("answer-m2");
    // Model text is shown as text, never parsed as markup.
    expect(answer.querySelector("img")).toBeNull();
    expect(answer.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(within(answer).getByRole("button", { name: "Source 1, verified" }).textContent).toBe(
      "1",
    );
    expect(within(answer).getByRole("button", { name: "Source 2, not verified" }).textContent).toBe(
      "2!",
    );
    expect(answer.textContent).toContain("anthropic/claude-haiku-5-5");
    expect(answer.textContent).toContain("1,500 tok");
  });

  it("opens a verified citation at its deep link, and a flagged one only in the list", async () => {
    serve({ ...signedIn, [`GET /api/v1/threads/${THREAD_ID}`]: () => [200, { thread: thread() }] });
    at(`#/t/${THREAD_ID}`);
    render(<App />);
    const answer = await screen.findByTestId("answer-m2");
    fireEvent.click(within(answer).getByRole("button", { name: "Source 2, not verified" }));
    expect(window.location.hash).toBe(`#/t/${THREAD_ID}`);
    expect(await screen.findByRole("dialog", { name: "Sources" })).toBeTruthy();

    fireEvent.click(within(answer).getByRole("button", { name: "Source 1, verified" }));
    await waitFor(() => expect(window.location.hash).toBe(`#/d/${DOC}/v/1?p=3&cf=0&ct=7`));
    const viewer = await screen.findByTestId("citation-viewer");
    expect(viewer.textContent).toContain("Page 3");
    expect(viewer.textContent).toContain("quote 1");
    // The thread stays in view behind the citation.
    expect(screen.getByTestId("answer-m2")).toBeTruthy();
  });

  it("flags sentences with no verified source", async () => {
    const flagged = { ...ANSWER, ungrounded: [[0, 6]] as [number, number][] };
    serve({
      ...signedIn,
      [`GET /api/v1/threads/${THREAD_ID}`]: () => [
        200,
        { thread: thread({ messages: [QUESTION, flagged] }) },
      ],
    });
    at(`#/t/${THREAD_ID}`);
    render(<App />);
    const answer = await screen.findByTestId("answer-m2");
    expect(answer.querySelector("mark")?.textContent).toContain("The ca");
  });

  it("warns when nothing in an answer was verified", async () => {
    const unchecked = { ...ANSWER, citations: [source(1, 0, "mismatch")] };
    serve({
      ...signedIn,
      [`GET /api/v1/threads/${THREAD_ID}`]: () => [
        200,
        { thread: thread({ messages: [QUESTION, unchecked] }) },
      ],
    });
    at(`#/t/${THREAD_ID}`);
    render(<App />);
    expect(await screen.findByText(/Nothing in this answer was checked/)).toBeTruthy();
  });

  it("hides the composer on a read-only thread and offers a copy", async () => {
    const sent = serve({
      ...signedIn,
      [`GET /api/v1/threads/${THREAD_ID}`]: () => [200, { thread: thread({ read_only: true }) }],
      [`POST /api/v1/threads/${THREAD_ID}/duplicate`]: () => [201, { thread_id: "copy-1" }],
    });
    at(`#/t/${THREAD_ID}`);
    render(<App />);
    await screen.findByTestId("answer-m2");
    expect(screen.queryByRole("textbox", { name: "Ask a question" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Share" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Duplicate to continue" }));
    await waitFor(() => expect(window.location.hash).toBe("#/t/copy-1"));
    expect(sent.some((c) => c.route === `POST /api/v1/threads/${THREAD_ID}/duplicate`)).toBe(true);
  });

  it("says when a thread doesn't exist, with a way out", async () => {
    serve(signedIn);
    at("#/t/nope");
    render(<App />);
    expect(await screen.findByText("Thread not found")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start a new thread" }));
    await waitFor(() => expect(window.location.hash).toBe("#/"));
  });
});

describe("a running answer", () => {
  const running = () => thread({ messages: [QUESTION], runs: [run("running")] });

  it("turns placeholders into markers as citations arrive, then shows the saved answer", async () => {
    let gets = 0;
    serve({
      ...signedIn,
      [`GET /api/v1/threads/${THREAD_ID}`]: () => {
        gets += 1;
        return [200, { thread: gets === 1 ? running() : thread() }];
      },
    });
    at(`#/t/${THREAD_ID}`);
    render(<App />);
    await waitFor(() => expect(FakeSource.all).toHaveLength(1));
    const stream = FakeSource.all[0];
    if (!stream) throw new Error("no stream");
    expect(stream.url).toBe(`/api/v1/runs/${RUN_ID}/events`);

    stream.emit("step", 1, {
      step_id: "s1",
      kind: "read",
      status: "started",
      title: "Reading msa.pdf",
    });
    stream.emit("token", 2, { message_id: "m2", delta: "The cap is one.[[c:1]]" });
    expect(screen.getByText("Reading msa.pdf")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Source 1, checking" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();

    stream.emit("citation", 3, {
      citation: {
        message_id: "m2",
        ordinal: 1,
        kind: "document",
        verified: "ok",
        document: { document_id: DOC, version_id: "v", name: "msa.pdf", page_no: 3 },
        quote: "one",
        open_url: `/d/${DOC}/v/1?p=3`,
      },
    });
    expect(screen.queryByRole("img", { name: "Source 1, checking" })).toBeNull();
    expect(screen.getByRole("button", { name: "Source 1, verified" })).toBeTruthy();

    stream.emit("done", 4, {
      message_id: "m2",
      model: "m",
      response_mode: "answer",
      usage: { input_tokens: 1, output_tokens: 1 },
      cost_usd: 0,
      citations: { total: 1, ok: 1, mismatch: 0, unresolved: 0, ungrounded_sentences: 0 },
      duration_ms: 5,
    });
    expect(stream.readyState).toBe(2);
    expect(await screen.findByTestId("answer-m2")).toBeTruthy();
    expect(gets).toBe(2);
  });

  it("shows an error with Retry, which asks the question again", async () => {
    const sent = serve({
      ...signedIn,
      [`GET /api/v1/threads/${THREAD_ID}`]: () => [200, { thread: running() }],
      [`POST /api/v1/threads/${THREAD_ID}/messages`]: () => [
        202,
        { thread_id: THREAD_ID, message_id: "m3", run_id: "r2" },
      ],
    });
    at(`#/t/${THREAD_ID}`);
    render(<App />);
    await waitFor(() => expect(FakeSource.all).toHaveLength(1));
    FakeSource.all[0]?.emit("error", 1, {
      code: "MODEL_UNAVAILABLE",
      message: "No model could answer just now.",
      retryable: false,
    });
    const card = await screen.findByRole("alert");
    expect(card.textContent).toContain("No model could answer just now.");
    fireEvent.click(within(card).getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(
        sent.find((c) => c.route === `POST /api/v1/threads/${THREAD_ID}/messages`)?.body,
      ).toEqual({
        content: "What is the cap?",
        scope: { document_ids: [DOC], vault_ids: [], sources: [] },
      }),
    );
  });

  it("stops a run on request", async () => {
    const sent = serve({
      ...signedIn,
      [`GET /api/v1/threads/${THREAD_ID}`]: () => [200, { thread: running() }],
      [`POST /api/v1/runs/${RUN_ID}/cancel`]: () => [202, null],
    });
    at(`#/t/${THREAD_ID}`);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Stop" }));
    await waitFor(() =>
      expect(sent.some((c) => c.route === `POST /api/v1/runs/${RUN_ID}/cancel`)).toBe(true),
    );
  });
});

describe("sharing", () => {
  it("names the people a thread couldn't be shared with, and why", async () => {
    const sent = serve({
      ...signedIn,
      [`GET /api/v1/threads/${THREAD_ID}`]: () => [200, { thread: thread() }],
      "GET /api/v1/members": () => [
        200,
        {
          items: [
            { id: "u2", name: "Bo Chen", email: "bo@acme.test" },
            { id: "u3", name: "Cy Diaz", email: "cy@acme.test" },
          ],
        },
      ],
      [`GET /api/v1/threads/${THREAD_ID}/shares`]: () => [200, { items: [] }],
      [`POST /api/v1/threads/${THREAD_ID}/shares`]: () => [
        200,
        { created: [], rejected: [{ id: "u2", reason: "WALL_DENIED" }] },
      ],
    });
    at(`#/t/${THREAD_ID}`);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Share" }));
    const search = await screen.findByRole("searchbox");
    fireEvent.change(search, { target: { value: "bo" } });
    fireEvent.click(screen.getByRole("button", { name: /Bo Chen/ }));
    const dialog = screen.getByRole("dialog", { name: "Share" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Share" }));
    const alert = await screen.findByText(/Bo Chen is walled off from this matter/);
    expect(alert).toBeTruthy();
    expect(sent.find((c) => c.route === `POST /api/v1/threads/${THREAD_ID}/shares`)?.body).toEqual({
      user_ids: ["u2"],
      link: false,
    });
  });
});

describe("history", () => {
  it("searches on the server and loads more", async () => {
    const item = (id: string, title: string) => ({
      id,
      title,
      type: "assist",
      matter_id: null,
      document_count: 2,
      model: "m",
      cost_usd: 0.02,
      last_activity_at: "2026-11-10T00:00:00.000Z",
      status: "done",
      favourite: false,
      shared: false,
    });
    const sent = serve({
      ...signedIn,
      "GET /api/v1/history": () => [200, { items: [item("t1", "Lease cap")], next_cursor: "c1" }],
      "GET /api/v1/history?cursor=c1": () => [
        200,
        { items: [item("t2", "Older one")], next_cursor: null },
      ],
      "GET /api/v1/history?q=cap": () => [
        200,
        { items: [item("t1", "Lease cap")], next_cursor: null },
      ],
    });
    at("#/history");
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Load more" })).toBeNull());
    expect(sent.some((c) => c.route === "GET /api/v1/history?cursor=c1")).toBe(true);

    fireEvent.change(screen.getByRole("searchbox", { name: "Search history" }), {
      target: { value: "cap" },
    });
    await waitFor(() =>
      expect(sent.some((c) => c.route === "GET /api/v1/history?q=cap")).toBe(true),
    );
  });
});
