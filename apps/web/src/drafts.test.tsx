import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { App } from "./App.js";
import type { Draft } from "./api.js";
import { at, serve, signedIn, THREAD_ID, thread } from "./testing.js";

const DRAFT_ID = "0190a000-0000-7000-8000-0000000000d1";

const draft = (over: Partial<Draft> = {}): Draft => ({
  id: DRAFT_ID,
  thread_id: THREAD_ID,
  kind: "editor",
  title: "Cap memo",
  read_only: false,
  versions: [
    { no: 1, author: "assistant", created_at: "2026-11-10T00:00:00.000Z", chars: 9, changes: null },
    { no: 2, author: "user", created_at: "2026-11-11T00:00:00.000Z", chars: 12, changes: null },
  ],
  latest: { no: 2, body: "The cap is 12." },
  ...over,
});

const base = {
  ...signedIn,
  [`GET /api/v1/threads/${THREAD_ID}`]: () => [200, { thread: thread() }] as [number, unknown],
};

async function openDrafts(routes: Parameters<typeof serve>[0]) {
  const sent = serve({ ...base, ...routes });
  at(`#/t/${THREAD_ID}`);
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Drafts" }));
  return { sent, panel: await screen.findByRole("dialog", { name: "Drafts" }) };
}

describe("drafts", () => {
  it("drafts from an answer and opens it", async () => {
    const sent = serve({
      ...base,
      [`POST /api/v1/threads/${THREAD_ID}/drafts`]: () => [201, { draft: draft() }],
      [`GET /api/v1/threads/${THREAD_ID}/drafts`]: () => [200, { items: [draft()] }],
    });
    at(`#/t/${THREAD_ID}`);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Draft from this answer" }));
    const panel = await screen.findByRole("dialog", { name: "Drafts" });
    expect(await within(panel).findByDisplayValue("The cap is 12.")).toBeTruthy();
    expect(
      sent.find((c) => c.route.startsWith("POST") && c.route.endsWith("/drafts"))?.body,
    ).toEqual({ kind: "editor", from_message_id: "m2" });
  });

  it("saves edits as a new version", async () => {
    const saved = draft({ latest: { no: 3, body: "The cap is 24." } });
    const { sent, panel } = await openDrafts({
      [`GET /api/v1/threads/${THREAD_ID}/drafts`]: () => [200, { items: [draft()] }],
      [`POST /api/v1/drafts/${DRAFT_ID}/versions`]: () => [201, { draft: saved }],
    });
    fireEvent.change(await within(panel).findByLabelText("Draft text"), {
      target: { value: "The cap is 24." },
    });
    fireEvent.click(within(panel).getByRole("button", { name: "Save as a new version" }));
    expect(await within(panel).findByRole("button", { name: "Saved" })).toBeTruthy();
    expect(sent.find((c) => c.route === `POST /api/v1/drafts/${DRAFT_ID}/versions`)?.body).toEqual({
      body: "The cap is 24.",
    });
  });

  it("shows why an assistant edit was refused", async () => {
    const { panel } = await openDrafts({
      [`GET /api/v1/threads/${THREAD_ID}/drafts`]: () => [200, { items: [draft()] }],
      [`POST /api/v1/drafts/${DRAFT_ID}/edit`]: () => [
        409,
        { code: "STALE", message: "The draft changed while the edit was made. Ask again." },
      ],
    });
    fireEvent.change(await within(panel).findByLabelText("Ask for edits"), {
      target: { value: "Shorter" },
    });
    fireEvent.click(within(panel).getByRole("button", { name: "Edit the draft" }));
    expect((await within(panel).findByRole("alert")).textContent).toBe(
      "The draft changed while the edit was made. Ask again.",
    );
  });

  it("shows the edits between versions", async () => {
    const { sent, panel } = await openDrafts({
      [`GET /api/v1/threads/${THREAD_ID}/drafts`]: () => [200, { items: [draft()] }],
      [`GET /api/v1/drafts/${DRAFT_ID}/diff?from=1&to=2`]: () => [
        200,
        {
          ops: [
            { op: "equal", text: "The cap is " },
            { op: "delete", text: "6" },
            { op: "insert", text: "12" },
          ],
          summary: null,
        },
      ],
    });
    fireEvent.click(await within(panel).findByRole("button", { name: "Show edits" }));
    expect((await within(panel).findByRole("insertion")).textContent).toContain("12");
    expect(sent.some((c) => c.route === `GET /api/v1/drafts/${DRAFT_ID}/diff?from=1&to=2`)).toBe(
      true,
    );
  });

  it("exports to Word with tracked changes", async () => {
    const created = vi.fn(() => "blob:x");
    vi.stubGlobal(
      "URL",
      Object.assign(URL, { createObjectURL: created, revokeObjectURL: vi.fn() }),
    );
    const { sent, panel } = await openDrafts({
      [`GET /api/v1/threads/${THREAD_ID}/drafts`]: () => [200, { items: [draft()] }],
      [`GET /api/v1/drafts/${DRAFT_ID}/export?tracked_from=1`]: () => [200, {}],
    });
    fireEvent.click(await within(panel).findByRole("button", { name: "Export to Word" }));
    await waitFor(() => expect(created).toHaveBeenCalled());
    expect(
      sent.some((c) => c.route === `GET /api/v1/drafts/${DRAFT_ID}/export?tracked_from=1`),
    ).toBe(true);
  });

  it("keeps a shared draft read-only", async () => {
    const { panel } = await openDrafts({
      [`GET /api/v1/threads/${THREAD_ID}/drafts`]: () => [
        200,
        { items: [draft({ read_only: true })] },
      ],
    });
    const text = await within(panel).findByLabelText("Draft text");
    expect(text).toHaveProperty("readOnly", true);
    expect(within(panel).queryByLabelText("Ask for edits")).toBeNull();
    expect(within(panel).queryByRole("button", { name: /Save/ })).toBeNull();
  });
});
