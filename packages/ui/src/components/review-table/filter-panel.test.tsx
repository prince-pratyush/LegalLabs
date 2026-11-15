// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanFilter, FilterPanel } from "./filter-panel.js";

afterEach(cleanup);
vi.setConfig({ testTimeout: 30_000 });

describe("cleanFilter", () => {
  it("is null when nothing is set", () => {
    expect(cleanFilter({ contains: "  ", status: [] })).toBeNull();
  });
});

describe("FilterPanel", () => {
  it("applies status, flag, verified and text together", async () => {
    const onApply = vi.fn();
    render(<FilterPanel columnLabel="Law" value={null} onApply={onApply} />);
    await userEvent.type(screen.getByLabelText("Value contains"), "Delaware");
    await userEvent.click(screen.getByLabelText("No answer"));
    await userEvent.click(screen.getByLabelText("Red"));
    await userEvent.click(screen.getByRole("radio", { name: "Not verified" }));
    await userEvent.click(screen.getByRole("button", { name: "Apply filter" }));
    expect(onApply).toHaveBeenCalledWith({
      status: ["null"],
      flag: ["red"],
      verified: false,
      contains: "Delaware",
    });
  });

  it("clears to null", async () => {
    const onApply = vi.fn();
    render(<FilterPanel columnLabel="Law" value={{ locked: true }} onApply={onApply} />);
    await userEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(onApply).toHaveBeenCalledWith(null);
  });
});
