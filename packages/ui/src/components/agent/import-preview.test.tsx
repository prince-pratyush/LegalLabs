// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImportPreview } from "./import-preview.js";

afterEach(cleanup);

describe("ImportPreview", () => {
  it("says what is dropped and confirms with the files left out", async () => {
    const onConfirm = vi.fn();
    render(
      <ImportPreview
        preview={{
          title: "NDA",
          description: "",
          instructions: "Do it.",
          files: [
            { label: "Playbook", name: "playbook.pdf", size: 2048, status: "ok" },
            { label: "Big", name: "big.mov", size: 1, status: "too_large" },
          ],
          refs: [],
          sources: [{ label: "Old", source: "x", status: "unknown_source" }],
          issues: [],
        }}
        onConfirm={onConfirm}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByText("Too large, dropped on import")).toBeTruthy();
    expect(screen.getByText("Unknown source, dropped on import")).toBeTruthy();
    await userEvent.click(screen.getByRole("checkbox", { name: /playbook\.pdf/ }));
    await userEvent.clear(screen.getByLabelText("Title"));
    await userEvent.type(screen.getByLabelText("Title"), "NDA review");
    await userEvent.click(screen.getByRole("button", { name: "Confirm import" }));
    expect(onConfirm).toHaveBeenCalledWith({ title: "NDA review", dropLabels: ["Playbook"] });
  });
});
