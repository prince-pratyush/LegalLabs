import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "./App.js";
import { at, CONTENT, DOC, serve, signedIn, THREAD_ID, thread } from "./testing.js";

const open = (reply: [number, unknown] = [202, { message_id: "m3", run_id: "r3" }]) => {
  const sent = serve({
    ...signedIn,
    [`GET /api/v1/threads/${THREAD_ID}`]: () => [200, { thread: thread() }],
    [`POST /api/v1/threads/${THREAD_ID}/translate`]: () => reply,
  });
  at(`#/t/${THREAD_ID}`);
  render(<App />);
  return () => sent.find((c) => c.route === `POST /api/v1/threads/${THREAD_ID}/translate`)?.body;
};

describe("translate", () => {
  it("translates the chosen files", async () => {
    const body = open();
    fireEvent.click(await screen.findByRole("button", { name: "Translate" }));
    fireEvent.change(screen.getByLabelText("Into"), { target: { value: "de" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "msa.pdf" }));
    fireEvent.click(screen.getByRole("button", { name: "Start translating" }));
    await waitFor(() => expect(body()).toEqual({ target_lang: "de", document_ids: [DOC] }));
  });

  it("sends an answer's words, and shows why it was refused", async () => {
    const body = open([403, { code: "MODEL_NOT_ALLOWED", message: "No model can translate." }]);
    fireEvent.click(await screen.findByRole("button", { name: "Translate this answer" }));
    expect(screen.getByLabelText("Or text")).toHaveProperty("value", CONTENT);
    fireEvent.click(screen.getByRole("button", { name: "Start translating" }));
    await waitFor(() => expect(body()).toEqual({ target_lang: "fr", text: CONTENT }));
    expect((await screen.findByRole("alert")).textContent).toContain("No model can translate");
  });
});
