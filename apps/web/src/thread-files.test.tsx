import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { App } from "./App.js";
import { ANSWER, at, QUESTION, serve, signedIn, THREAD_ID, thread } from "./testing.js";

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const made = () =>
  thread({
    messages: [QUESTION, ANSWER],
    outputs: [
      {
        id: "out-1",
        message_id: ANSWER.id,
        name: "Fee schedule.xlsx",
        format: "xlsx",
        size: 2048,
        created_at: "2026-11-10T00:00:00.000Z",
      },
    ],
  });

describe("files a thread made", () => {
  it("shows a card under the answer and saves the file", async () => {
    const sent = serve({
      ...signedIn,
      [`GET /api/v1/threads/${THREAD_ID}`]: () => [200, { thread: made() }],
      "GET /api/v1/thread-outputs/out-1/download": () => [200, new Blob(["x"], { type: XLSX })],
    });
    const created = vi.fn(() => "blob:x");
    URL.createObjectURL = created;
    URL.revokeObjectURL = vi.fn();
    at(`#/t/${THREAD_ID}`);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Download Fee schedule.xlsx" }));
    await waitFor(() => expect(created).toHaveBeenCalled());
    expect(sent.some((c) => c.route === "GET /api/v1/thread-outputs/out-1/download")).toBe(true);
  });

  it("says why when a source forbids it", async () => {
    serve({
      ...signedIn,
      [`GET /api/v1/threads/${THREAD_ID}`]: () => [200, { thread: made() }],
      "GET /api/v1/thread-outputs/out-1/download": () => [
        403,
        { code: "EXPORT_DISABLED", message: "A source vault doesn't allow copies or downloads." },
      ],
    });
    at(`#/t/${THREAD_ID}`);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Download Fee schedule.xlsx" }));
    expect((await screen.findByRole("alert")).textContent).toContain("doesn't allow copies");
  });
});
