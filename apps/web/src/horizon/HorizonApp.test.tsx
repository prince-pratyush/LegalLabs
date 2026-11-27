import type { HorizonItem, HorizonScan } from "@legallabs/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NoResize } from "../testing.js";
import { HorizonApp } from "./HorizonApp.js";
import { horizonHash, parseHorizonRoute } from "./route.js";

// The real table is virtualised, and jsdom lays nothing out, so it would draw no rows.
vi.mock("@legallabs/ui", async (original) => ({
  ...(await original<typeof import("@legallabs/ui")>()),
  DataTable: <T extends object>(props: {
    label: string;
    columns: { id: string; header: string; cell: (row: T) => ReactNode }[];
    rows: T[];
    getRowId: (row: T) => string;
    empty: ReactNode;
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
        {props.rows.length === 0 && (
          <tr>
            <td>{props.empty}</td>
          </tr>
        )}
      </tbody>
    </table>
  ),
}));

// Invented ids and names.
const id = (n: number) => `0190d000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const SCAN = id(1);

const scan = (over: Partial<HorizonScan> = {}): HorizonScan => ({
  id: SCAN,
  name: "Widgets",
  purpose: "Widget labelling",
  jurisdictions: ["US"],
  industries: [],
  topics: ["Labelling"],
  sources: ["fr"],
  from_date: "2026-11-20",
  relevance_floor: "medium",
  health: "ok",
  failing_sources: [],
  stopped: false,
  items: 2,
  unread: 2,
  high: 1,
  last_refresh_at: null,
  next_refresh_at: null,
  created_at: "2026-11-20T00:00:00.000Z",
  ...over,
});

const item = (n: number, over: Partial<HorizonItem> = {}): HorizonItem => ({
  id: id(10 + n),
  scan_id: SCAN,
  development: `Widget rule ${n}`,
  summary: "<img src=x onerror=alert(1)>",
  relevance: "high",
  explanation: `Why ${n} matters.`,
  type: "rule",
  industries: [],
  topics: ["Labelling"],
  jurisdictions: ["US"],
  sources: ["fr"],
  published_at: "2026-11-21",
  source_url: `https://www.federalregister.gov/d/2026-0000${n}`,
  state: { read: false, starred: false, archived: false },
  ...over,
});

let sent: { method: string; url: string; body: unknown }[] = [];
let enabled = true;
let scans: HorizonScan[] = [scan()];
let items: HorizonItem[] = [];

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", NoResize);
  sent = [];
  enabled = true;
  scans = [scan()];
  items = [item(1), item(2, { relevance: "low" })];
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    const url = input.replace("/api/v1/horizon", "");
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    sent.push({ method, url, body });
    const answer = (value: unknown, status = 200) =>
      new Response(status === 204 ? null : JSON.stringify(value), { status });
    if (url === "/settings") {
      if (method === "PUT") {
        enabled = body.enabled;
        return answer(body);
      }
      return answer({ enabled, can_manage: true, can_create: enabled });
    }
    if (url === "/scans" && method === "POST") return answer({ scan: scan() }, 201);
    if (url === "/scans") return answer({ scans });
    if (url === `/scans/${SCAN}`) return answer({ scan: scan() });
    if (url.startsWith(`/scans/${SCAN}/items`)) return answer({ items, next_cursor: null });
    if (input === "/api/v1/vaults") {
      return answer({
        vaults: [
          { id: id(30), name: "Mine", my_access: "owner" },
          { id: id(31), name: "Read only", my_access: "view" },
        ],
      });
    }
    if (input.startsWith("/api/v1/documents/")) {
      return answer({ document: { id: id(40), status: "indexed" } });
    }
    if (url.endsWith("/save-to-vault")) return answer({ document_id: id(40) }, 201);
    if (url.endsWith("/ask")) return answer({ thread_id: id(50), document_id: id(40) }, 201);
    if (url.endsWith("/draft-email")) return answer({ thread_id: id(50), draft_id: id(51) }, 201);
    if (url === "/items/bulk") return answer({ changed: body.ids.length });
    if (url.endsWith("/state")) return answer(undefined, 204);
    return answer({ code: "NOT_FOUND", message: "That wasn't found." }, 404);
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = "";
});

const at = (hash: string) => {
  window.location.hash = hash;
  render(<HorizonApp onLeave={() => {}} />);
};
const last = (path: string) => sent.findLast((s) => s.url.includes(path));

describe("horizon routes", () => {
  it("reads and writes the same addresses", () => {
    for (const route of [
      { page: "list" },
      { page: "new" },
      { page: "scan", scanId: SCAN },
      { page: "edit", scanId: SCAN },
    ] as const) {
      expect(parseHorizonRoute(horizonHash(route))).toEqual(route);
    }
    expect(parseHorizonRoute("#/intake")).toBeNull();
    expect(parseHorizonRoute("#/horizon/%zz")).toBeNull();
  });
});

describe("horizon screens", () => {
  it("lists scans with what is unread", async () => {
    at("#/horizon");
    expect(await screen.findByRole("link", { name: "Widgets" })).toBeTruthy();
    expect(screen.getByText("2 unread")).toBeTruthy();
  });

  it("lets an admin turn scanning on where it is off", async () => {
    enabled = false;
    at("#/horizon");
    expect(await screen.findByText(/turned off for this workspace/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "New scan" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Turn on for the workspace" }));
    expect(await screen.findByRole("button", { name: "New scan" })).toBeTruthy();
  });

  it("creates a scan filled in by hand", async () => {
    at("#/horizon/new");
    fireEvent.click(screen.getByRole("button", { name: "Create scan" }));
    expect((await screen.findByRole("alert")).textContent).toContain("at least one source");
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Widgets" } });
    fireEvent.change(screen.getByLabelText("Purpose"), { target: { value: "Labels" } });
    fireEvent.change(screen.getByLabelText("Topics"), { target: { value: "a, b, a," } });
    fireEvent.click(screen.getByLabelText("Federal Register"));
    fireEvent.click(screen.getByRole("button", { name: "Create scan" }));
    await waitFor(() => expect(window.location.hash).toBe(`#/horizon/${SCAN}`));
    expect(sent.find((s) => s.method === "POST")?.body).toMatchObject({
      name: "Widgets",
      topics: ["a", "b"],
      sources: ["fr"],
    });
  });

  it("collapses items below the floor and shows them on asking", async () => {
    at(`#/horizon/${SCAN}`);
    expect(await screen.findByRole("button", { name: "Widget rule 1" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Widget rule 2" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show 1 below your relevance floor" }));
    expect(screen.getByRole("button", { name: "Widget rule 2" })).toBeTruthy();
  });

  it("opens an item as text, marks it read and links only over https", async () => {
    items = [item(1), item(3, { source_url: "javascript:alert(1)" })];
    at(`#/horizon/${SCAN}`);
    fireEvent.click(await screen.findByRole("button", { name: "Widget rule 1" }));
    expect(screen.getByText("Why 1 matters.")).toBeTruthy();
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open at the source" }).getAttribute("rel")).toBe(
      "noopener noreferrer",
    );
    await waitFor(() => expect(last("/state")?.body).toEqual({ read: true }));
    fireEvent.click(screen.getByRole("button", { name: "Widget rule 3" }));
    expect(screen.queryByRole("link", { name: "Open at the source" })).toBeNull();
  });

  it("filters by tab and by column", async () => {
    at(`#/horizon/${SCAN}`);
    await screen.findByRole("button", { name: "Widget rule 1" });
    fireEvent.change(screen.getByLabelText("Relevance"), { target: { value: "high" } });
    await waitFor(() => expect(last("/items?")?.url).toContain("relevance=high"));
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Starred" }), { button: 0 });
    await waitFor(() => expect(last("/items?")?.url).toContain("tab=starred"));
  });

  it("archives and stars many at once", async () => {
    at(`#/horizon/${SCAN}`);
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select Widget rule 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    await waitFor(() =>
      expect(last("/items/bulk")?.body).toEqual({ ids: [id(11)], action: "archive" }),
    );
    await waitFor(() => expect(screen.queryByText("1 selected")).toBeNull());
  });

  const open = async () => {
    at(`#/horizon/${SCAN}`);
    fireEvent.click(await screen.findByRole("button", { name: "Widget rule 1" }));
  };

  it("saves an item only into a vault that can be written to", async () => {
    await open();
    await screen.findByRole("option", { name: "Mine" });
    expect(screen.queryByRole("option", { name: "Read only" })).toBeNull();
    const save = screen.getByRole("button", { name: "Save to vault" });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Vault"), { target: { value: id(30) } });
    fireEvent.click(save);
    expect(await screen.findByText("Saved to the vault.")).toBeTruthy();
    expect(last("/save-to-vault")?.body).toEqual({ vault_id: id(30) });
  });

  it("goes to the new thread once the file has been read", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Ask about this" }));
    await waitFor(() => expect(window.location.hash).toBe(`#/t/${id(50)}`));
  });

  it("goes to the email draft", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Draft email" }));
    await waitFor(() => expect(window.location.hash).toBe(`#/t/${id(50)}?drafts=${id(51)}`));
  });
});
