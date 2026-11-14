import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "./App.js";
import {
  ANSWER,
  at,
  DOC,
  FakeSource,
  QUESTION,
  RUN_ID,
  run,
  SCOPE,
  serve,
  signedIn,
  source,
  THREAD_ID,
  thread,
} from "./testing.js";

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
    const panel = await screen.findByRole("dialog", { name: "Sources" });
    const flagged = within(panel).getByRole("region", { name: "Source 2" });
    expect(flagged.textContent).toContain("Couldn't verify on the page");
    expect(flagged.textContent).toContain("quote 2");
    // Choosing another flagged source in the list selects it instead of opening anything.
    fireEvent.click(within(panel).getByRole("button", { name: /\[3\]/ }));
    expect(within(panel).getByRole("region", { name: "Source 3" }).textContent).toContain(
      "quote 3",
    );
    expect(window.location.hash).toBe(`#/t/${THREAD_ID}`);

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
