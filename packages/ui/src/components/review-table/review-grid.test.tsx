// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fakeLayout } from "./fake-layout.js";
import { sampleCellFor, sampleColumns, sampleRows } from "./fixtures.js";
import { type CellRef, moveCell, ReviewGrid } from "./review-grid.js";

// Grid renders are slow under jsdom on a busy machine.
vi.setConfig({ testTimeout: 30_000 });
let restore = () => {};
beforeAll(() => {
  restore = fakeLayout();
});
afterAll(() => restore());
afterEach(cleanup);

function Harness(props: {
  onOpen?: (c: CellRef) => void;
  onCellKey?: (op: string, c: CellRef) => void;
  onEdit?: (c: CellRef, v: string) => void;
  onSelect?: (keys: Set<string>) => void;
  rows?: number;
}) {
  const [active, setActive] = useState<CellRef | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  return (
    <ReviewGrid
      label="DD table"
      rows={sampleRows(props.rows ?? 8)}
      columns={sampleColumns}
      getCell={sampleCellFor}
      active={active}
      onActiveChange={setActive}
      selected={selected}
      onSelectionChange={(keys) => {
        setSelected(keys);
        props.onSelect?.(keys);
      }}
      onOpen={props.onOpen ?? (() => {})}
      onCellKey={props.onCellKey ?? (() => {})}
      onEdit={props.onEdit ?? (() => {})}
    />
  );
}

const cell = (row: string, col: string) =>
  document.querySelector<HTMLElement>(`[data-cell="${row}:${col}"]`) as HTMLElement;

describe("moveCell", () => {
  const size = { rows: 10, cols: 4, page: 5 };
  it("moves and clamps at the edges", () => {
    expect(moveCell("ArrowRight", { row: 0, col: 3 }, size)).toEqual({ row: 0, col: 3 });
    expect(moveCell("ArrowDown", { row: 2, col: 1 }, size)).toEqual({ row: 3, col: 1 });
    expect(moveCell("PageDown", { row: 8, col: 1 }, size)).toEqual({ row: 9, col: 1 });
    expect(moveCell("End", { row: 2, col: 0 }, size)).toEqual({ row: 2, col: 3 });
    expect(moveCell("x", { row: 2, col: 0 }, size)).toBeNull();
  });
});

describe("ReviewGrid", () => {
  it("renders a fixed document column and only some cells", () => {
    render(<Harness rows={500} />);
    expect(screen.getByRole("grid", { name: "DD table" }).getAttribute("aria-rowcount")).toBe(
      "501",
    );
    expect(screen.getAllByRole("rowheader")[0]?.textContent).toContain("1-MSA_Acme.pdf");
    expect(screen.getAllByRole("row").length).toBeLessThan(60);
  });

  it("opens a cell on click and moves with arrow keys", async () => {
    const onOpen = vi.fn();
    render(<Harness onOpen={onOpen} />);
    await userEvent.click(cell("r1", "k1"));
    expect(onOpen).toHaveBeenLastCalledWith({ rowId: "r1", columnId: "k1" });
    await userEvent.keyboard("{ArrowRight}{ArrowDown}{Enter}");
    expect(onOpen).toHaveBeenLastCalledWith({ rowId: "r2", columnId: "k2" });
    expect(document.activeElement).toBe(cell("r2", "k2"));
  });

  it("sends V, F and L for the active cell", async () => {
    const onCellKey = vi.fn();
    render(<Harness onCellKey={onCellKey} />);
    await userEvent.click(cell("r3", "k1"));
    await userEvent.keyboard("vfl");
    expect(onCellKey.mock.calls.map(([op]) => op)).toEqual(["verify", "flag", "lock"]);
    expect(onCellKey).toHaveBeenCalledWith("verify", { rowId: "r3", columnId: "k1" });
  });

  it("selects a rectangle with shift-click and clears it with Escape", async () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    await userEvent.click(cell("r1", "k1"));
    fireEvent.click(cell("r3", "k2"), { shiftKey: true });
    expect(onSelect).toHaveBeenLastCalledWith(
      new Set(["r1:k1", "r1:k2", "r2:k1", "r2:k2", "r3:k1", "r3:k2"]),
    );
    expect(cell("r2", "k2").getAttribute("aria-selected")).toBe("true");
    await userEvent.keyboard("{Escape}");
    expect(onSelect).toHaveBeenLastCalledWith(new Set());
  });

  it("edits inline on double-click and saves on Enter", async () => {
    const onEdit = vi.fn();
    render(<Harness onEdit={onEdit} />);
    await userEvent.dblClick(cell("r2", "k1"));
    const input = screen.getByRole("textbox", { name: "Edit Governing law" });
    await userEvent.clear(input);
    await userEvent.type(input, "England{Enter}");
    expect(onEdit).toHaveBeenCalledWith({ rowId: "r2", columnId: "k1" }, "England");
  });

  it("won't edit a locked cell", async () => {
    render(<Harness />);
    // Row 6 is flagged and locked in the fixtures.
    await userEvent.dblClick(cell("r6", "k1"));
    expect(screen.queryByRole("textbox")).toBeNull();
  });
});
