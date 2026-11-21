// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ColumnBuilder } from "./column-builder.js";

afterEach(cleanup);
vi.setConfig({ testTimeout: 30_000 });

const PROPOSALS = [
  { label: "Rent", type: "currency" as const, prompt: "Annual rent?", options: {} },
  { label: "Start", type: "date" as const, prompt: "Start date?", options: {} },
];

describe("ColumnBuilder", () => {
  it("proposes columns and adds only the ticked ones", async () => {
    const onGenerate = vi.fn().mockResolvedValue(PROPOSALS);
    const onAdd = vi.fn();
    render(<ColumnBuilder onGenerate={onGenerate} onAdd={onAdd} onClose={() => {}} />);
    await userEvent.type(screen.getByLabelText("What should the table capture?"), "Lease terms");
    await userEvent.click(screen.getByRole("button", { name: "Generate columns" }));
    expect(onGenerate).toHaveBeenCalledWith("Lease terms");
    await userEvent.click(await screen.findByRole("checkbox", { name: "Add Start" }));
    await userEvent.click(screen.getByRole("button", { name: "Add 1 column" }));
    expect(onAdd).toHaveBeenCalledWith([PROPOSALS[0]]);
  });

  it("shows why generation failed", async () => {
    const onGenerate = vi.fn().mockRejectedValue(new Error("The model is busy."));
    render(<ColumnBuilder onGenerate={onGenerate} onAdd={() => {}} onClose={() => {}} />);
    await userEvent.type(screen.getByLabelText("What should the table capture?"), "Lease terms");
    await userEvent.click(screen.getByRole("button", { name: "Generate columns" }));
    expect((await screen.findByRole("alert")).textContent).toBe("The model is busy.");
  });
});
