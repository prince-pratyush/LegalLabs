// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "./components/app-shell.js";
import { DataTable } from "./components/data-table.js";
import { CellDrawer } from "./components/review-table/cell-drawer.js";
import { TableList } from "./components/review-table/table-list.js";

const screenIs = (phone: boolean) =>
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("max-width: 767") ? phone : !phone,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = "";
});

const shell = () =>
  render(
    <AppShell brand="LegalLabs" sidebarLabel="Threads" sidebar={<a href="#/history">History</a>}>
      <p>Page body</p>
    </AppShell>,
  );

describe("app shell on a phone", () => {
  it("keeps the navigation in a drawer that opens and closes", async () => {
    screenIs(true);
    shell();
    expect(screen.queryByRole("navigation", { name: "Threads" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    const drawer = screen.getByRole("dialog", { name: "Threads" });
    expect(within(drawer).getByRole("link", { name: "History" })).toBeTruthy();
    fireEvent.keyDown(drawer, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("closes the drawer once a screen is chosen", async () => {
    screenIs(true);
    shell();
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("leaves the sidebar in place on a wide screen", () => {
    screenIs(false);
    shell();
    expect(screen.getByRole("navigation", { name: "Threads" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open menu" })).toBeNull();
  });
});

describe("tables on a phone", () => {
  const table = () =>
    render(
      <DataTable
        label="Files"
        columns={[
          { id: "name", header: "Name", cell: () => "lease.pdf" },
          { id: "size", header: "Size", secondary: true, cell: () => "2 MB" },
        ]}
        rows={[{ id: "1" }]}
        getRowId={(r) => r.id}
        empty="None"
      />,
    );

  it("drops the secondary columns", () => {
    screenIs(true);
    table();
    expect(screen.getByRole("columnheader", { name: "Name" })).toBeTruthy();
    expect(screen.queryByRole("columnheader", { name: "Size" })).toBeNull();
  });

  it("keeps every column on a wide screen", () => {
    screenIs(false);
    table();
    expect(screen.getByRole("columnheader", { name: "Size" })).toBeTruthy();
  });

  it("offers no way to create a review table without a handler", () => {
    render(
      <TableList
        tables={[]}
        starredOnly={false}
        onStarredOnlyChange={() => {}}
        onStar={() => {}}
        onOpen={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: /create/i })).toBeNull();
  });

  it("shows a cell without any editing control when read-only", () => {
    const noop = () => {};
    render(
      <CellDrawer
        readOnly
        columnLabel="Cap"
        documentName="lease.pdf"
        detail={null}
        onClose={noop}
        onRerun={noop}
        onVerify={noop}
        onFlag={noop}
        onLock={noop}
        onSave={noop}
        onOpenCitation={noop}
      />,
    );
    for (const name of [/re-run/i, /verify/i, /flag/i, /lock/i]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    expect(screen.getByRole("button", { name: "Close cell detail" })).toBeTruthy();
  });
});
