// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AddColumnForm } from "./add-column.js";

afterEach(cleanup);
vi.setConfig({ testTimeout: 30_000 });

describe("AddColumnForm", () => {
  it("adds a Yes/No column as classify", async () => {
    const onAdd = vi.fn();
    render(<AddColumnForm onAdd={onAdd} />);
    await userEvent.click(screen.getByRole("radio", { name: "Yes/No" }));
    await userEvent.type(screen.getByLabelText("Column name"), "Change of control");
    await userEvent.type(screen.getByLabelText("What to look for"), "Is there a CoC clause?");
    await userEvent.click(screen.getByRole("button", { name: "Add column" }));
    expect(onAdd).toHaveBeenCalledWith(
      expect.objectContaining({ label: "Change of control", type: "classify" }),
    );
  });

  it("says what's missing instead of saving", async () => {
    const onAdd = vi.fn();
    render(<AddColumnForm onAdd={onAdd} />);
    await userEvent.click(screen.getByRole("button", { name: "Add column" }));
    expect(screen.getByRole("alert").textContent).toBe("Name the column.");
    expect(onAdd).not.toHaveBeenCalled();
  });

  it("needs no prompt for a manual column", async () => {
    const onAdd = vi.fn();
    render(<AddColumnForm onAdd={onAdd} />);
    await userEvent.click(screen.getByRole("radio", { name: "Manual" }));
    await userEvent.type(screen.getByLabelText("Column name"), "Notes");
    await userEvent.click(screen.getByRole("button", { name: "Add column" }));
    expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ type: "manual", prompt: "" }));
  });
});
