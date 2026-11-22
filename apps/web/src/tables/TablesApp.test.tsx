// biome-ignore-all lint/a11y/useSemanticElements: the grid stand-in mirrors the real ARIA grid roles
// biome-ignore-all lint/a11y/useFocusableInteractive: the stand-in only needs to be found, not focused
import type { Cell, Column, ReviewTable, Row } from "@legallabs/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { keyPatch, nextFlag, TablePage, toRowFilter } from "./TablePage.js";
import { createBody, TablesApp } from "./TablesApp.js";

// A first render takes ~0.2 s alone, but seconds when the whole web suite runs on a busy
// machine; findBy's default 1 s then fails tests that are fine.
const FIRST_RENDER_MS = 10_000;

// The real grid and list are virtualised and jsdom lays nothing out, so they draw nothing.
vi.mock("@legallabs/ui", async (original) => ({
  ...(await original<typeof import("@legallabs/ui")>()),
  DataTable: <T extends object>(props: {
    label: string;
    columns: { id: string; cell: (row: T) => ReactNode }[];
    rows: T[];
    getRowId: (row: T) => string;
  }) => (
    <table aria-label={props.label}>
      <tbody>
        {props.rows.map((row) => (
          <tr key={props.getRowId(row)}>
            {props.columns.map((column) => (
              <td key={column.id}>{column.cell(row)}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  ),
  ReviewGrid: (props: {
    label: string;
    rows: { id: string }[];
    columns: { id: string; label: string }[];
    renderHeader: (c: { id: string; label: string }) => ReactNode;
    onOpen: (ref: { rowId: string; columnId: string }) => void;
  }) => (
    <div role="grid" aria-label={props.label}>
      {props.columns.map((c) => (
        <div key={c.id} role="columnheader">
          {props.renderHeader(c)}
        </div>
      ))}
      {props.rows.map((r) =>
        props.columns.map((c) => (
          <button
            key={`${r.id}:${c.id}`}
            type="button"
            onClick={() => props.onOpen({ rowId: r.id, columnId: c.id })}
          >
            open {r.id} {c.label}
          </button>
        )),
      )}
    </div>
  ),
}));

const T = "0190a000-0000-7000-8000-00000000000a";
const K = "0190a000-0000-7000-8000-00000000000b";
const R = "0190a000-0000-7000-8000-00000000000c";
const C = "0190a000-0000-7000-8000-00000000000d";

const TABLE: ReviewTable = {
  id: T,
  workspace_id: T,
  owner_id: T,
  name: "DD table",
  source_kind: "vault",
  vault_id: T,
  folder_ids: null,
  thread_id: null,
  matter_id: null,
  instructions: "",
  settings: {
    default_language: "en",
    date_format: "ISO",
    currency_display: "code",
    number_decimals: 2,
    null_display: "—",
    wrap_mode: "compact",
  },
  stats: {
    rows: 1,
    columns: 1,
    cells_done: 1,
    cells_null: 0,
    cells_error: 0,
    cost_usd: 0,
    valid_citation_rate: 1,
  },
  starred: false,
  created_at: "2026-11-15T00:00:00Z",
  updated_at: "2026-11-15T00:00:00Z",
};

const COLUMN: Column = {
  id: K,
  ordinal: 0,
  label: "Governing law",
  type: "free",
  prompt: "Which law?",
  language: null,
  model: null,
  context_document_id: null,
  options: {},
  depends_on: [],
  state: "partial",
  dry_run: true,
  progress: { done: 1, total: 10, null: 0, error: 0, cost_usd: 0 },
  run_id: null,
};

const ROW: Row = {
  id: R,
  ordinal: 0,
  document_ids: [T],
  documents: [{ id: T, name: "MSA.pdf", status: "ready", version_no: 1 }],
  restricted: false,
  flag_color: null,
  locked: false,
  source_removed: false,
  version_no: null,
  newer_version: false,
};

const CELL: Cell = {
  id: C,
  row_id: R,
  column_id: K,
  status: "done",
  error_code: null,
  value_text: "Delaware",
  value_typed: { kind: "free", markdown: "Delaware" },
  reasoning: "Clause 14.",
  looked_at: null,
  citation_count: 1,
  verified_citation_count: 1,
  verified_by: null,
  verified_at: null,
  locked: false,
  edited_by: null,
  flag_color: null,
  stale_since: null,
  model: "local",
  usage: null,
  cost_usd: 0,
  run_id: null,
  updated_at: "2026-11-15T00:00:00Z",
};

type Handler = (body: unknown) => [number, unknown];

function serve(routes: Record<string, Handler>) {
  const sent: { route: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const path = url.replace("/api/v1", "").split("?")[0];
      const route = `${init.method ?? "GET"} ${path}`;
      const body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
      sent.push({ route, body });
      const handler = routes[route];
      if (!handler) return new Response(JSON.stringify({ code: "NOT_FOUND" }), { status: 404 });
      const [status, json] = handler(body);
      return new Response(status === 204 ? null : JSON.stringify(json), { status });
    }),
  );
  return sent;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = "";
});
vi.setConfig({ testTimeout: 30_000 });

describe("cell keys", () => {
  it("cycles flags and refuses changes to a locked cell except unlocking", () => {
    expect(nextFlag(null)).toBe("red");
    expect(nextFlag("purple")).toBeNull();
    expect(keyPatch("verify", CELL)).toEqual({ verified: true });
    expect(keyPatch("flag", { ...CELL, flag_color: "red" })).toEqual({ flag_color: "orange" });
    expect(keyPatch("verify", { ...CELL, locked: true })).toBeNull();
    expect(keyPatch("lock", { ...CELL, locked: true })).toEqual({ locked: false });
  });

  it("turns column filters into row conditions", () => {
    expect(toRowFilter({ [K]: { verified: true } })).toEqual({
      conditions: [{ column_id: K, verified: true }],
    });
  });
});

describe("createBody", () => {
  it("uploads files first and sends their ids", async () => {
    const upload = vi.fn(async (file: File) => ({ id: `${file.name}-id` }));
    const body = await createBody(
      { name: "NDAs", source: { kind: "uploads", files: [new File(["x"], "a.pdf")] } },
      upload,
    );
    expect(body).toEqual({ name: "NDAs", source: { kind: "uploads", upload_ids: ["a.pdf-id"] } });
  });

  it("passes a thread through", async () => {
    expect(await createBody({ source: { kind: "thread", thread_id: T } })).toEqual({
      source: { kind: "thread", thread_id: T },
    });
  });
});

describe("TablesApp list", () => {
  // The list's table lives inside the ui package, so give its virtualiser a window to fill.
  const saved = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
  beforeAll(() => {
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get: () => 480,
    });
  });
  afterAll(() => {
    if (saved) Object.defineProperty(HTMLElement.prototype, "clientHeight", saved);
    else Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
  });

  it("stars a table", async () => {
    const sent = serve({
      "GET /review-tables": () => [200, { items: [TABLE], next_cursor: null }],
      [`POST /review-tables/${T}/star`]: () => [204, null],
    });
    window.location.hash = "#/tables";
    render(<TablesApp onLeave={() => {}} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Star DD table" }, { timeout: FIRST_RENDER_MS }),
    );
    await waitFor(() =>
      expect(sent.map((s) => s.route)).toContain(`POST /review-tables/${T}/star`),
    );
    expect(screen.getByRole("button", { name: "Unstar DD table" })).toBeTruthy();
  });
});

describe("TablePage", () => {
  const routes = (extra: Record<string, Handler> = {}) =>
    serve({
      [`GET /review-tables/${T}`]: () => [200, { table: TABLE, columns: [COLUMN] }],
      [`GET /review-tables/${T}/rows`]: () => [
        200,
        { rows: [ROW], cells: [CELL], next_cursor: null },
      ],
      [`GET /review-tables/${T}/cells/${C}`]: () => [
        200,
        { cell: CELL, citations: [], history: [] },
      ],
      ...extra,
    });

  it("shows a dry run in the header and runs the remaining rows", async () => {
    const sent = routes({
      [`POST /review-tables/${T}/columns/${K}/run`]: () => [202, { run_id: null }],
    });
    render(<TablePage tableId={T} onBack={() => {}} />);
    const header = await screen.findByRole("columnheader", {}, { timeout: FIRST_RENDER_MS });
    expect(header.textContent).toContain("Dry run · 1/10 · $0");
    fireEvent.click(within(header).getByRole("button", { name: "Run remaining" }));
    await waitFor(() =>
      expect(sent.find((s) => s.route.endsWith("/run"))?.body).toEqual({
        scope: "pending",
        include_verified: false,
        include_dependents: false,
      }),
    );
  });

  it("shows the sync state in the header and turns sync on from its panel", async () => {
    const status = {
      mode: "off",
      folder_ids: null,
      notify: false,
      state: "off",
      pending_rows: 0,
      removed_rows: 0,
      last_synced_at: null,
    };
    const sent = routes({
      [`GET /review-tables/${T}/sync`]: () => [200, status],
      [`GET /vaults/${T}/tree`]: () => [200, { folders: [], files: [], next_cursor: null }],
      [`PUT /review-tables/${T}/sync`]: (body) => [
        200,
        { ...status, ...(body as object), state: "pending", pending_rows: 2 },
      ],
    });
    // The checkbox in the panel measures itself, which jsdom can't.
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    render(<TablePage tableId={T} onBack={() => {}} />);
    // Sync is off, so there is no indicator yet, only the button to open the panel.
    fireEvent.click(
      await screen.findByRole("button", { name: "Sync" }, { timeout: FIRST_RENDER_MS }),
    );
    fireEvent.click(await screen.findByRole("radio", { name: /Entire vault/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(sent.find((s) => s.route === `PUT /review-tables/${T}/sync`)?.body).toEqual({
        mode: "entire_vault",
        notify: false,
      }),
    );
    expect((await screen.findByRole("button", { name: /^Sync settings/ })).textContent).toBe(
      "Sync pending (2)",
    );
  });

  it("opens a cell in the drawer and verifies it", async () => {
    const sent = routes({
      [`PATCH /review-tables/${T}/cells/${C}`]: () => [
        200,
        { cell: { ...CELL, verified_at: "2026-11-15T01:00:00Z" } },
      ],
    });
    render(<TablePage tableId={T} onBack={() => {}} />);
    fireEvent.click(
      await screen.findByRole(
        "button",
        { name: /open .* Governing law/ },
        { timeout: FIRST_RENDER_MS },
      ),
    );
    const drawer = await screen.findByRole("region", { name: "Governing law for MSA.pdf" });
    await waitFor(() => expect(drawer.getAttribute("aria-busy")).toBeNull());
    fireEvent.click(within(drawer).getByRole("button", { name: "Verify" }));
    await waitFor(() =>
      expect(sent.find((s) => s.route.startsWith("PATCH"))?.body).toEqual({ verified: true }),
    );
    fireEvent.keyDown(drawer, { key: "Escape" });
    expect(screen.queryByRole("region", { name: "Governing law for MSA.pdf" })).toBeNull();
  });
});
