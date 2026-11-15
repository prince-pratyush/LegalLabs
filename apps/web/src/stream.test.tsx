import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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

const OTHER = "0190a000-0000-7000-8000-0000000000f2";
const running = () => thread({ messages: [QUESTION], runs: [run("running")] });

async function openRunning() {
  serve({
    ...signedIn,
    [`GET /api/v1/threads/${THREAD_ID}`]: () => [200, { thread: running() }],
    [`GET /api/v1/threads/${OTHER}`]: () => [
      200,
      { thread: thread({ id: OTHER, runs: [run("done", "m2")] }) },
    ],
  });
  at(`#/t/${THREAD_ID}`);
  const view = render(<App />);
  await waitFor(() => expect(FakeSource.all).toHaveLength(1));
  return view;
}

const latest = () => {
  const source = FakeSource.all.at(-1);
  if (!source) throw new Error("no stream");
  return source;
};

afterEach(() => {
  vi.useRealTimers();
});

describe("a run's stream", () => {
  it("reopens after a drop, resuming after the last event", async () => {
    await openRunning();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    latest().emit("token", 4, { message_id: "m2", delta: "The cap" });
    latest().drop();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(FakeSource.all).toHaveLength(2);
    expect(latest().url).toBe(`/api/v1/runs/${RUN_ID}/events?after=4`);
    latest().emit("token", 5, { message_id: "m2", delta: " is one." });
    expect(screen.getByText(/The cap is one\./)).toBeTruthy();
  });

  it("says the connection was lost after repeated drops, and reconnects on request", async () => {
    await openRunning();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    for (const wait of [1000, 2000, 4000]) {
      latest().drop();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(wait);
      });
    }
    latest().drop();
    expect(FakeSource.all).toHaveLength(4);
    expect(await screen.findByText(/Connection lost/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    await waitFor(() => expect(FakeSource.all).toHaveLength(5));
    expect(latest().open).toBe(true);
  });

  it("closes the stream when the thread changes or the page goes away", async () => {
    const view = await openRunning();
    const first = latest();
    act(() => {
      window.location.hash = `#/t/${OTHER}`;
    });
    await waitFor(() => expect(first.open).toBe(false));

    act(() => {
      window.location.hash = `#/t/${THREAD_ID}`;
    });
    await waitFor(() => expect(FakeSource.all).toHaveLength(2));
    const second = latest();
    view.unmount();
    expect(second.open).toBe(false);
    cleanup();
  });
});
