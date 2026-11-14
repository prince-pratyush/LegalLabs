import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "./App.js";
import {
  at,
  FakeSource,
  QUESTION,
  RUN_ID,
  run,
  serve,
  signedIn,
  THREAD_ID,
  thread,
} from "./testing.js";

const PLAN = {
  steps: [
    { id: "p1", title: "Read the leases", sources: ["msa.pdf"], estimate: { docs: 4, pages: 120 } },
  ],
  estimated_cost_usd: { low: 0.4, high: 0.9 },
  editable: true,
};

const waiting = () =>
  thread({
    messages: [QUESTION],
    runs: [{ ...run("awaiting_approval"), kind: "deep_analysis", plan: PLAN }],
  });

describe("deep analysis", () => {
  it("asks for a deep analysis when the toggle is on", async () => {
    const sent = serve({
      ...signedIn,
      "GET /api/v1/scope-options": () => [
        200,
        { vaults: [{ id: "vault-1", name: "Leases", file_count: 3 }], sources: [], models: [] },
      ],
      "POST /api/v1/threads": () => [
        202,
        { thread_id: THREAD_ID, message_id: "m1", run_id: RUN_ID },
      ],
      [`GET /api/v1/threads/${THREAD_ID}`]: () => [200, { thread: waiting() }],
    });
    render(<App />);
    const box = await screen.findByRole("textbox", { name: "Ask a question" });
    fireEvent.click(screen.getByRole("button", { name: "Deep" }));
    fireEvent.change(box, { target: { value: "Review @Lea", selectionStart: 11 } });
    fireEvent.keyDown(box, { key: "Enter" });
    fireEvent.change(box, { target: { value: "Review @Leases now", selectionStart: 18 } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(window.location.hash).toBe(`#/t/${THREAD_ID}`));
    expect(sent.find((c) => c.route === "POST /api/v1/threads")?.body).toMatchObject({
      deep_analysis: true,
    });
  });

  it("shows a waiting plan again after a reload, blocks the composer, and approves", async () => {
    const sent = serve({
      ...signedIn,
      [`GET /api/v1/threads/${THREAD_ID}`]: () => [200, { thread: waiting() }],
      [`POST /api/v1/runs/${RUN_ID}/approve`]: () => [202, null],
    });
    at(`#/t/${THREAD_ID}`);
    render(<App />);
    const card = await screen.findByRole("region", { name: "Plan awaiting approval" });
    expect(card.textContent).toContain("Read the leases");
    expect(card.textContent).toContain("$0.40");
    expect(screen.getByText("Answer above to continue.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send" })).toHaveProperty("disabled", true);

    fireEvent.click(within(card).getByRole("button", { name: "Approve" }));
    await waitFor(() =>
      expect(sent.some((c) => c.route === `POST /api/v1/runs/${RUN_ID}/approve`)).toBe(true),
    );
  });

  it("re-plans from an instruction, and cancels", async () => {
    const sent = serve({
      ...signedIn,
      [`GET /api/v1/threads/${THREAD_ID}`]: () => [
        200,
        { thread: thread({ messages: [QUESTION], runs: [run("planned")] }) },
      ],
      [`POST /api/v1/runs/${RUN_ID}/plan/edit`]: () => [202, null],
      [`POST /api/v1/runs/${RUN_ID}/cancel`]: () => [202, null],
    });
    at(`#/t/${THREAD_ID}`);
    render(<App />);
    await waitFor(() => expect(FakeSource.all).toHaveLength(1));
    const stream = FakeSource.all[0];
    if (!stream) throw new Error("no stream");
    expect(await screen.findByText("Planning the analysis…")).toBeTruthy();
    stream.emit("plan", 1, { plan: PLAN });
    stream.emit("status", 2, { status: "awaiting_approval" });

    const card = await screen.findByRole("region", { name: "Plan awaiting approval" });
    fireEvent.click(within(card).getByRole("button", { name: "Edit" }));
    fireEvent.change(within(card).getByLabelText("What should change?"), {
      target: { value: "Skip side letters" },
    });
    fireEvent.click(within(card).getByRole("button", { name: "Re-plan" }));
    await waitFor(() =>
      expect(sent.find((c) => c.route === `POST /api/v1/runs/${RUN_ID}/plan/edit`)?.body).toEqual({
        instruction: "Skip side letters",
      }),
    );

    stream.emit("plan", 3, {
      plan: { ...PLAN, steps: [{ ...PLAN.steps[0], title: "Read the leases only" }] },
    });
    expect(card.textContent).toContain("Read the leases only");
    fireEvent.click(within(card).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(sent.some((c) => c.route === `POST /api/v1/runs/${RUN_ID}/cancel`)).toBe(true),
    );
  });

  it("shows steps and how much was read while it runs", async () => {
    serve({
      ...signedIn,
      [`GET /api/v1/threads/${THREAD_ID}`]: () => [
        200,
        { thread: thread({ messages: [QUESTION], runs: [run("running")] }) },
      ],
    });
    at(`#/t/${THREAD_ID}`);
    render(<App />);
    await waitFor(() => expect(FakeSource.all).toHaveLength(1));
    const stream = FakeSource.all[0];
    stream?.emit("step", 1, {
      step_id: "p1",
      kind: "read",
      status: "started",
      title: "Read the leases",
    });
    stream?.emit("coverage", 2, {
      coverage: {
        docs_in_scope: 4,
        docs_read: 1,
        pages_in_scope: 120,
        pages_read: 30,
        mode: "deep_analysis",
      },
    });
    expect(screen.getByRole("progressbar", { name: "Files read" })).toHaveProperty(
      "ariaValueNow",
      "25",
    );
    expect(screen.getByText(/Read 1 of 4 files \(25%\)/)).toBeTruthy();
    expect(screen.getByText("Read the leases")).toBeTruthy();
  });

  it("lists deep analyses in history by type", async () => {
    serve({
      ...signedIn,
      "GET /api/v1/history": () => [
        200,
        {
          items: [
            {
              id: "t1",
              title: "Lease review",
              type: "deep_analysis",
              matter_id: null,
              document_count: 40,
              model: "m",
              cost_usd: 0.8,
              last_activity_at: "2026-11-10T00:00:00.000Z",
              status: "done",
              favourite: false,
              shared: false,
            },
          ],
          next_cursor: null,
        },
      ],
    });
    at("#/history");
    render(<App />);
    expect(await screen.findByText("Deep analysis")).toBeTruthy();
  });
});
