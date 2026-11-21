// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ColumnHeader, progressLine } from "./column-header.js";
import { sampleColumn } from "./fixtures.js";

afterEach(cleanup);
vi.setConfig({ testTimeout: 30_000 });

const progress = { done: 4, total: 10, null: 0, error: 0, cost_usd: 0.42 };

describe("progressLine", () => {
  it("names a dry run and shows cost", () => {
    expect(progressLine({ state: "partial", dry_run: true, progress })).toBe(
      "Dry run · 4/10 · $0.42",
    );
    expect(progressLine({ state: "running", dry_run: false, progress })).toBe("4/10 · $0.42");
    expect(
      progressLine({ state: "pending", dry_run: false, progress: { ...progress, done: 0 } }),
    ).toBeNull();
  });
});

describe("ColumnHeader", () => {
  const handlers = () => ({
    onRun: vi.fn(),
    onRerun: vi.fn(),
    onRunRemaining: vi.fn(),
    onEditPrompt: vi.fn(),
    onStop: vi.fn(),
    onSort: vi.fn(),
    onFilter: vi.fn(),
    onDelete: vi.fn(),
  });

  it("stops a running column", async () => {
    const h = handlers();
    render(<ColumnHeader column={sampleColumn({ state: "running" })} rowCount={3} {...h} />);
    await userEvent.click(screen.getByRole("button", { name: "Stop Governing law" }));
    expect(h.onStop).toHaveBeenCalled();
  });

  it("says which columns it uses", () => {
    render(
      <ColumnHeader column={sampleColumn()} rowCount={3} uses={["Term", "Fee"]} {...handlers()} />,
    );
    expect(screen.getByRole("img", { name: "Uses Term, Fee" })).toBeTruthy();
  });

  it("offers Run remaining after a dry run", async () => {
    const h = handlers();
    render(
      <ColumnHeader
        column={sampleColumn({ state: "partial", dry_run: true })}
        rowCount={3}
        {...h}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Run remaining" }));
    expect(h.onRunRemaining).toHaveBeenCalled();
  });

  it("sorts and deletes from the menu, naming the row count", async () => {
    const h = handlers();
    render(<ColumnHeader column={sampleColumn()} rowCount={1204} {...h} />);
    await userEvent.click(screen.getByRole("button", { name: "Governing law menu" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Sort descending" }));
    expect(h.onSort).toHaveBeenCalledWith("desc");
    await userEvent.click(screen.getByRole("button", { name: "Governing law menu" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Delete column" }));
    expect(screen.getByRole("alertdialog").textContent).toContain("1,204 rows");
    await userEvent.click(screen.getByRole("button", { name: "Delete column" }));
    expect(h.onDelete).toHaveBeenCalled();
  });
});
