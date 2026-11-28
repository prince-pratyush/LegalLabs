import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App.js";
import { fakeHost, ITEM } from "../test/fake-host.js";

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const stream = (...events: [string, unknown][]) =>
  new Response(
    events.map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`).join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );

const ANSWER = {
  id: "m2",
  role: "assistant",
  content: "Serve it by 4 March.",
  ungrounded: [],
  citations: [
    {
      n: 1,
      at: 20,
      document_name: "Lease.pdf",
      page: 2,
      quote: "served by 4 March",
      status: "ok",
      open_url: "/documents/d2?page=2",
    },
  ],
};

type Handler = (init?: RequestInit) => Response;

function serve(overrides: Record<string, Handler> = {}) {
  const calls: { path: string; init?: RequestInit | undefined }[] = [];
  const routes: Record<string, Handler> = {
    "/api/v1/addins/outlook/items": () =>
      reply(
        {
          thread_id: "t1",
          documents: [{ document_id: "d1", name: "Email.txt", kind: "email", status: "queued" }],
          skipped: [{ name: "photo.png", reason: "UNSUPPORTED_TYPE" }],
        },
        201,
      ),
    "/api/v1/documents/d1": () => reply({ document: { status: "indexed" } }),
    "/api/v1/threads/t1/messages": () => reply({ run_id: "r1" }, 202),
    "/api/v1/runs/r1/events": () => stream(["token", { delta: "Serve it" }], ["done", {}]),
    "/api/v1/runs/r1": () => reply({ run: { status: "done", message_id: "m2" } }),
    "/api/v1/threads/t1": () => reply({ thread: { messages: [ANSWER] } }),
    ...overrides,
  };
  vi.stubGlobal("fetch", async (path: string, init?: RequestInit) => {
    calls.push({ path, init });
    return routes[path]?.(init) ?? reply({ code: "NOT_FOUND", message: "Not found." }, 404);
  });
  return { calls, count: (path: string) => calls.filter((c) => c.path === path).length };
}

const askIt = async (question: string) => {
  await userEvent.type(screen.getByLabelText("Ask about this email"), question);
  await userEvent.click(screen.getByRole("button", { name: "Ask" }));
};

const pane = (host = fakeHost().host) =>
  render(<App host={host} origin="https://legal.test" openDialog={async () => ""} />);

describe("asking about the open email", () => {
  beforeEach(() => localStorage.setItem("legallabs.outlook.token", "t".repeat(43)));
  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("sends the email once, answers with sources, and says what wasn't read", async () => {
    const api = serve();
    const { host, opened } = fakeHost();
    pane(host);
    await askIt("When is notice due?");
    expect(await screen.findByText(/Serve it by 4 March/)).toBeTruthy();
    expect(screen.getByText("Not read: photo.png (can't be read)")).toBeTruthy();
    await userEvent.click(screen.getAllByRole("button", { name: /Lease\.pdf|1/ })[0] as Element);
    expect(opened).toEqual(["https://legal.test/documents/d2?page=2"]);

    await askIt("And the rent?");
    await screen.findByText(/Serve it by 4 March/);
    expect(api.count("/api/v1/addins/outlook/items")).toBe(1);
    expect(api.count("/api/v1/threads/t1/messages")).toBe(2);
    for (const call of api.calls) {
      expect(new Headers(call.init?.headers).get("x-legallabs-client")).toBe("outlook");
    }
  });

  it("never turns the sender's words into markup", async () => {
    serve({
      "/api/v1/threads/t1": () =>
        reply({
          thread: {
            messages: [{ ...ANSWER, content: '<img src="x" onerror="alert(1)">', citations: [] }],
          },
        }),
    });
    const { container } = pane();
    await askIt("What does it say?");
    expect(await screen.findByText(/onerror/)).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
  });

  it("asks which matter when the workspace requires one", async () => {
    let sent = 0;
    const api = serve({
      "/api/v1/addins/outlook/items": (init) => {
        sent += 1;
        const matter = (init?.body as FormData | undefined)?.get("matter_id");
        return matter === "m-1"
          ? reply({ thread_id: "t1", documents: [], skipped: [] }, 201)
          : reply({ code: "MATTER_REQUIRED", message: "Choose a matter." }, 400);
      },
      "/api/v1/matters?scope=picker": () =>
        reply({
          items: [{ id: "m-1", client_name: "Acme", matter_name: "Deal", matter_number: "0001" }],
        }),
    });
    pane();
    await askIt("When?");
    await userEvent.selectOptions(await screen.findByLabelText("Matter"), "m-1");
    await userEvent.click(screen.getByRole("button", { name: "Ask" }));
    expect(await screen.findByText(/Serve it by 4 March/)).toBeTruthy();
    expect(sent).toBe(2);
    expect(api.count("/api/v1/threads/t1/messages")).toBe(1);
  });

  it("keeps the thread when the session ends, and drops it for someone who can't see it", async () => {
    let expired = false;
    let visible = true;
    serve({
      "/api/v1/threads/t1/messages": () =>
        expired ? reply({ code: "UNAUTHENTICATED" }, 401) : reply({ run_id: "r1" }, 202),
      "/api/v1/threads/t1": () =>
        visible ? reply({ thread: { messages: [ANSWER] } }) : reply({ code: "NOT_FOUND" }, 404),
      "/auth/addin/exchange": () =>
        reply({ token: "u".repeat(43), user_id: "u", workspace_id: "w" }),
    });
    const openDialog = async () => JSON.stringify({ code: "c".repeat(43) });
    render(<App host={fakeHost().host} origin="https://legal.test" openDialog={openDialog} />);
    await askIt("When?");
    await screen.findByText(/Serve it by 4 March/);

    expired = true;
    await askIt("Again?");
    await userEvent.click(await screen.findByRole("button", { name: "Sign in" }));
    expect(await screen.findByText(/Serve it by 4 March/)).toBeTruthy();
    expect(screen.getByText("Follow-ups stay in this thread.")).toBeTruthy();

    visible = false;
    expired = true;
    await askIt("And again?");
    await userEvent.click(await screen.findByRole("button", { name: "Sign in" }));
    await vi.waitFor(() =>
      expect(screen.queryByText("Follow-ups stay in this thread.")).toBeNull(),
    );
  });

  it("starts over for a different email", () => {
    serve();
    const { host } = fakeHost({ ...ITEM, itemId: "other", attachments: [] });
    pane(host);
    expect(screen.getByText("This email")).toBeTruthy();
    expect(screen.queryByText("Follow-ups stay in this thread.")).toBeNull();
  });
});
