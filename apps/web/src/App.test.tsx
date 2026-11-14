import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";
import type { Citation, DocumentSummary, Thread } from "./api.js";

const DOCUMENT: DocumentSummary = {
  id: "0190a000-0000-7000-8000-000000000001",
  version_id: "0190a000-0000-7000-8000-000000000002",
  name: "msa.pdf",
  mime: "application/pdf",
  size: 1000,
  status: "indexed",
  failure_reason: null,
  page_count: 10,
  empty_page_count: 2,
  matter_id: null,
  created_at: "2026-11-10T00:00:00.000Z",
};

const source = (n: number, at: number, status: Citation["status"]): Citation => ({
  n,
  at,
  document_id: status === "unresolved" ? null : DOCUMENT.id,
  version_id: status === "unresolved" ? null : DOCUMENT.version_id,
  document_name: status === "unresolved" ? null : DOCUMENT.name,
  page: 3,
  quote: `quote ${n}`,
  char_from: status === "ok" ? 0 : null,
  char_to: status === "ok" ? 7 : null,
  status,
});

const CONTENT = "The cap is <img src=x onerror=alert(1)> one. Two. Three.";

const THREAD: Thread = {
  id: "0190a000-0000-7000-8000-000000000003",
  title: "What is the cap?",
  matter_id: null,
  created_at: "2026-11-10T00:00:00.000Z",
  documents: [
    {
      id: DOCUMENT.id,
      version_id: DOCUMENT.version_id,
      name: DOCUMENT.name,
      page_count: 10,
      empty_page_count: 2,
    },
  ],
  messages: [
    {
      id: "m1",
      role: "user",
      content: "What is the cap?",
      model: null,
      created_at: "2026-11-10T00:00:00.000Z",
      citations: [],
    },
    {
      id: "m2",
      role: "assistant",
      content: CONTENT,
      model: "anthropic/claude-haiku-5-5",
      created_at: "2026-11-10T00:00:00.000Z",
      citations: [
        source(1, CONTENT.indexOf(" one.") + 4, "ok"),
        source(2, CONTENT.indexOf(" Two") + 4, "mismatch"),
        source(3, CONTENT.indexOf(" Three") + 6, "unresolved"),
      ],
    },
  ],
};

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

const signedIn: Record<string, Handler> = {
  "GET /auth/session": () => [200, { user_id: "u", workspace_id: "w" }],
  "GET /api/v1/documents": () => [200, { documents: [DOCUMENT] }],
  "GET /api/v1/threads": () => [200, { threads: [] }],
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the page", () => {
  it("signs in, then shows the documents and how many pages had no text", async () => {
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

    expect(await screen.findByLabelText(/msa\.pdf/)).toBeTruthy();
    expect(screen.getByText(/2 of 10 pages had no readable text/)).toBeTruthy();
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

  it("asks about the chosen documents and shows each source's check", async () => {
    const sent = serve({ ...signedIn, "POST /api/v1/threads": () => [201, { thread: THREAD }] });
    render(<App />);
    fireEvent.click(await screen.findByLabelText(/msa\.pdf/));
    fireEvent.change(screen.getByLabelText("Question"), {
      target: { value: "What is the cap?" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));

    const answer = await screen.findByTestId("answer-m2");
    expect(sent.find((call) => call.route === "POST /api/v1/threads")?.body).toEqual({
      question: "What is the cap?",
      document_ids: [DOCUMENT.id],
    });
    // Model text is shown as text, never parsed as markup.
    expect(answer.querySelector("img")).toBeNull();
    expect(answer.textContent).toContain("<img src=x onerror=alert(1)>");

    const verified = within(answer).getByRole("button", { name: "Source 1, verified" });
    const misquoted = within(answer).getByRole("button", { name: "Source 2, not verified" });
    expect(within(answer).getByRole("button", { name: "Source 3, not verified" })).toBeTruthy();
    expect(verified.textContent).toBe("1");
    expect(misquoted.textContent).toBe("2!");

    const sources = screen.getByRole("region", { name: "Sources" });
    const items = within(sources).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items[0]?.textContent).toMatch(/msa\.pdf.*page 3.*quote 1.*Verified/);
    expect(items[1]?.textContent).toMatch(/msa\.pdf.*page 3.*quote 2.*Not verified/);
    expect(items[1]?.textContent).toContain("quote wasn't found on that page");
    expect(items[2]?.textContent).toMatch(/Unknown document.*quote 3.*Not verified/);
    expect(items[2]?.textContent).toContain("couldn't be checked");
    for (const item of items.slice(1)) expect(item.textContent).not.toMatch(/\bVerified/);

    fireEvent.click(misquoted);
    await waitFor(() => expect(document.activeElement).toBe(items[1]));
  });

  it("shows the API's message when an answer can't be given", async () => {
    serve({
      ...signedIn,
      "POST /api/v1/threads": () => [
        503,
        { code: "MODEL_UNAVAILABLE", message: "No model could answer just now." },
      ],
    });
    render(<App />);
    fireEvent.click(await screen.findByLabelText(/msa\.pdf/));
    fireEvent.change(screen.getByLabelText("Question"), { target: { value: "Cap?" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    expect((await screen.findByRole("alert")).textContent).toBe("No model could answer just now.");
  });

  describe("an answer with no checked source", () => {
    const UNSUPPORTED = /Nothing in this answer was checked against your documents/;

    async function show(answer: Partial<Thread["messages"][number]>) {
      const [question, reply] = THREAD.messages;
      if (!question || !reply) throw new Error("fixture changed");
      const thread = { ...THREAD, messages: [question, { ...reply, ...answer }] };
      serve({ ...signedIn, "POST /api/v1/threads": () => [201, { thread }] });
      render(<App />);
      fireEvent.click(await screen.findByLabelText(/msa\.pdf/));
      fireEvent.change(screen.getByLabelText("Question"), { target: { value: "Cap?" } });
      fireEvent.click(screen.getByRole("button", { name: "Ask" }));
      return screen.findByTestId("answer-m2");
    }

    it("warns when the model cited nothing", async () => {
      await show({ content: "The cap is twelve months of fees.", citations: [] });
      expect(screen.getByText(UNSUPPORTED)).toBeTruthy();
    });

    it("warns when no citation could be verified", async () => {
      await show({ citations: [source(1, 0, "mismatch"), source(2, 0, "unresolved")] });
      expect(screen.getByText(UNSUPPORTED)).toBeTruthy();
    });

    it("doesn't warn once one source is verified", async () => {
      await show({});
      expect(screen.queryByText(UNSUPPORTED)).toBeNull();
    });

    it("doesn't warn on the fixed not-found reply, which makes no claim", async () => {
      await show({ model: null, content: "That wasn't found.", citations: [] });
      expect(screen.queryByText(UNSUPPORTED)).toBeNull();
    });
  });

  it("won't ask without a chosen document", async () => {
    serve(signedIn);
    render(<App />);
    fireEvent.change(await screen.findByLabelText("Question"), { target: { value: "Cap?" } });
    expect(screen.getByRole("button", { name: "Ask" })).toHaveProperty("disabled", true);
  });
});
