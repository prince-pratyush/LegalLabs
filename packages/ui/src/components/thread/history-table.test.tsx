// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type HistoryRow, NO_FILTERS } from "./history.js";
import { HistoryTable } from "./history-table.js";

// jsdom lays nothing out, so the virtualiser would see a zero-height window and render no rows.
const sizes = { clientHeight: 480, clientWidth: 800 } as const;
const saved = Object.fromEntries(
  Object.keys(sizes).map((key) => [
    key,
    Object.getOwnPropertyDescriptor(HTMLElement.prototype, key),
  ]),
);
beforeAll(() => {
  for (const [key, value] of Object.entries(sizes)) {
    Object.defineProperty(HTMLElement.prototype, key, { configurable: true, get: () => value });
  }
});
afterAll(() => {
  for (const [key, descriptor] of Object.entries(saved)) {
    // These live on Element.prototype, so removing the stub restores them.
    if (descriptor) Object.defineProperty(HTMLElement.prototype, key, descriptor);
    else Reflect.deleteProperty(HTMLElement.prototype, key);
  }
});
afterEach(cleanup);

const ROW: HistoryRow = {
  id: "1",
  title: "Liability cap",
  type: "assist",
  documentCount: 1,
  lastActivityAt: "2026-11-14T09:00:00Z",
  status: "done",
  favourite: false,
  restricted: false,
};

const handlers = { onOpen: vi.fn(), onFavourite: vi.fn(), onStart: vi.fn() };

describe("HistoryTable", () => {
  it("hands search to the server when filters are controlled", async () => {
    const onFiltersChange = vi.fn();
    // Title doesn't contain the query: the server matched the prompt, so it must still show.
    render(
      <HistoryTable
        {...handlers}
        rows={[ROW]}
        filters={{ ...NO_FILTERS, search: "indemnity" }}
        onFiltersChange={onFiltersChange}
      />,
    );
    expect(screen.getByText("Liability cap")).toBeTruthy();
    await userEvent.type(screen.getByRole("searchbox"), "x");
    expect(onFiltersChange).toHaveBeenLastCalledWith({ ...NO_FILTERS, search: "indemnityx" });
  });

  it("filters titles locally when uncontrolled", async () => {
    render(<HistoryTable {...handlers} rows={[ROW]} />);
    await userEvent.type(screen.getByRole("searchbox"), "zzz");
    expect(screen.queryByText("Liability cap")).toBeNull();
    expect(screen.getByText("No results")).toBeTruthy();
  });

  it("shows Unknown for a bad date instead of throwing", () => {
    render(<HistoryTable {...handlers} rows={[{ ...ROW, lastActivityAt: "nope" }]} />);
    expect(screen.getByText("Unknown")).toBeTruthy();
  });
});
