// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BulkBar, sheetText } from "./bulk-bar.js";

afterEach(cleanup);
vi.setConfig({ testTimeout: 30_000 });

describe("sheetText", () => {
  it("states count, columns, time, cost and what is kept", () => {
    expect(sheetText({ op: "rerun" }, 312, 2, { est_cost_usd: 1.8, est_minutes: 5.4 })).toBe(
      "Re-run 312 cells in 2 columns · ~6 min · ~$1.80 · verified and locked cells preserved",
    );
    expect(sheetText({ op: "flag", flag_color: "red" }, 1, 1)).toBe("Flag red 1 cell in 1 column");
  });
});

describe("BulkBar", () => {
  it("asks before re-running and confirms on Enter", async () => {
    const onConfirm = vi.fn();
    render(
      <BulkBar
        cellCount={312}
        columnCount={2}
        estimate={async () => ({ est_cost_usd: 1.8, est_minutes: 5.4 })}
        onConfirm={onConfirm}
        onClear={() => {}}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Re-run" }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(await screen.findByText(/~\$1\.80/)).toBeTruthy();
    await userEvent.keyboard("{Enter}");
    expect(onConfirm).toHaveBeenCalledWith({ op: "rerun" });
  });

  it("cancels with Escape and keeps the selection", async () => {
    const onConfirm = vi.fn();
    render(<BulkBar cellCount={3} columnCount={1} onConfirm={onConfirm} onClear={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Lock" }));
    await userEvent.keyboard("{Escape}");
    expect(screen.getByText("3 cells selected")).toBeTruthy();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("flags in the chosen colour", async () => {
    const onConfirm = vi.fn();
    render(<BulkBar cellCount={3} columnCount={1} onConfirm={onConfirm} onClear={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Flag" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Purple" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(onConfirm).toHaveBeenCalledWith({ op: "flag", flag_color: "purple" });
  });
});
