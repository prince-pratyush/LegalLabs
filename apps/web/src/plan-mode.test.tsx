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
  steps: [{ id: "step-1", title: "Read the lease", sources: [], estimate: { docs: 1, pages: 2 } }],
  estimated_cost_usd: { low: 0.01, high: 0.02 },
  editable: true,
};

const open = (status: Parameters<typeof run>[0]) => {
  const sent = serve({
    ...signedIn,
    [`GET /api/v1/threads/${THREAD_ID}`]: () => [
      200,
      { thread: thread({ messages: [QUESTION], runs: [{ ...run(status), plan: PLAN }] }) },
    ],
    [`POST /api/v1/runs/${RUN_ID}/answer`]: () => [202, null],
  });
  at(`#/t/${THREAD_ID}`);
  render(<App />);
  return sent;
};

describe("plan mode", () => {
  it("shows the run's question and sends a skip", async () => {
    const sent = open("awaiting_input");
    await waitFor(() => expect(FakeSource.all).toHaveLength(1));
    const stream = FakeSource.all[0] as FakeSource;
    // A reload replays the plan's approval; the stream must stay open past it.
    stream.emit("status", 1, { status: "awaiting_approval" });
    stream.emit("question", 2, {
      step_id: "q1",
      question: {
        text: "Which party?",
        options: [{ id: "o1", label: "Tenant" }],
        allow_text: true,
        allow_skip: true,
      },
    });
    stream.emit("status", 3, { status: "awaiting_input" });
    expect(stream.open).toBe(true);
    expect(await screen.findByText("Which party?")).toBeTruthy();
    expect(screen.getByText("Answer above to continue.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    await waitFor(() =>
      expect(sent.find((c) => c.route === `POST /api/v1/runs/${RUN_ID}/answer`)?.body).toEqual({
        question_id: "q1",
        skip: true,
      }),
    );
  });

  it("shows progress, outputs and sources beside the thread", async () => {
    open("awaiting_approval");
    fireEvent.click(await screen.findByRole("button", { name: "Context" }));
    const progress = await screen.findByRole("region", { name: "Progress" });
    expect(progress.textContent).toContain("Read the lease");
    expect(screen.getByRole("region", { name: "Outputs" }).textContent).toContain("No files yet");
    const sources = screen.getByRole("region", { name: "Sources" });
    expect(within(sources).getByText("msa.pdf")).toBeTruthy();
  });

  it("asks for a plan when the toggle is on", async () => {
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
    });
    render(<App />);
    const box = await screen.findByRole("textbox", { name: "Ask a question" });
    fireEvent.click(screen.getByRole("button", { name: "Plan" }));
    fireEvent.change(box, { target: { value: "Review @Lea", selectionStart: 11 } });
    fireEvent.keyDown(box, { key: "Enter" });
    fireEvent.change(box, { target: { value: "Review @Leases now", selectionStart: 18 } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() =>
      expect(sent.find((c) => c.route === "POST /api/v1/threads")?.body).toMatchObject({
        plan_mode: true,
      }),
    );
  });
});
