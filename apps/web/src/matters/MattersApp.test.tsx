import { DEFAULT_MATTER_OPTIONS, type Matter, type WallRow } from "@legallabs/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NoResize } from "../testing.js";
import { MatterPicker } from "./MatterPicker.js";
import { MattersApp } from "./MattersApp.js";
import { mattersHash, parseMattersRoute } from "./route.js";

// The real table is virtualised, and jsdom lays nothing out, so it would draw no rows.
vi.mock("@legallabs/ui", async (original) => ({
  ...(await original<typeof import("@legallabs/ui")>()),
  DataTable: <T extends object>(props: {
    label: string;
    columns: { id: string; header: string; cell: (row: T) => ReactNode }[];
    rows: T[];
    getRowId: (row: T) => string;
    onActivate?: (row: T) => void;
  }) => (
    <table aria-label={props.label}>
      <tbody>
        {props.rows.map((row) => (
          <tr key={props.getRowId(row)} onClick={() => props.onActivate?.(row)}>
            {props.columns.map((column) => (
              <td key={column.id}>{column.cell(row)}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  ),
}));

const M1: Matter = {
  id: "0190a000-0000-7000-8000-0000000000a1",
  client_id: "00123",
  client_name: "Acme Corp",
  matter_number: "0001",
  matter_name: "Acme acquisition",
  description: "",
  notice_md: "Conflict screen: do not discuss with the Beta team.",
  notice_version: 2,
  wall_mode: "allow_list",
  allow_in_queries: true,
  retention_hours: null,
  require_walls_for_sharing: false,
  model_policy: null,
  status: "active",
  source: "manual",
  external_ref: null,
  display: "00123-0001 Acme Corp",
  space_id: null,
  acknowledged: false,
  walls_count: 2,
};
const M2: Matter = {
  ...M1,
  id: "0190a000-0000-7000-8000-0000000000a2",
  matter_number: "0002",
  matter_name: "Beta dispute",
  notice_md: null,
  wall_mode: "open",
  display: "00123-0002 Acme Corp",
  acknowledged: true,
};
const WALL = (over: Partial<WallRow>): WallRow => ({
  id: "0190a000-0000-7000-8000-0000000000b1",
  matter_id: M1.id,
  matter_display: M1.display,
  principal_type: "group",
  principal_id: "0190a000-0000-7000-8000-0000000000c1",
  principal_label: "corp-team",
  effect: "allow",
  provider: "internal",
  synced_at: null,
  created_at: "2026-11-10T00:00:00.000Z",
  ...over,
});

type Call = { url: string; method: string; body: unknown };
let calls: Call[] = [];

function serve(routes: (call: Call) => Response | undefined) {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const body =
        typeof init.body === "string"
          ? JSON.parse(init.body)
          : init.body instanceof FormData
            ? Object.fromEntries(init.body.entries())
            : null;
      const call = { url, method: init.method ?? "GET", body };
      calls.push(call);
      return routes(call) ?? new Response(null, { status: 404 });
    }),
  );
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function adminApi(extra: (call: Call) => Response | undefined = () => undefined) {
  serve((call) => {
    const found = extra(call);
    if (found) return found;
    if (call.url.startsWith("/api/v1/matters?") || call.url === "/api/v1/matters") {
      return json({ items: [M1, M2], next_cursor: null });
    }
    if (call.url === "/api/v1/admin/matters/options") return json(DEFAULT_MATTER_OPTIONS);
    if (call.url.startsWith("/api/v1/admin/walls?")) {
      return json({
        items: [
          WALL({}),
          WALL({
            id: "0190a000-0000-7000-8000-0000000000b2",
            principal_type: "user",
            principal_label: "ben@acme.test",
            effect: "deny",
            provider: "csv",
          }),
        ],
      });
    }
    if (call.url === "/api/v1/admin/walls/provider") {
      return json({
        kind: "internal",
        cadence_minutes: null,
        last_sync_at: null,
        last_status: null,
        supported: ["internal", "csv"],
      });
    }
    return undefined;
  });
}

beforeEach(() => {
  window.location.hash = "#/admin/matters";
  vi.stubGlobal("ResizeObserver", NoResize);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("matters route", () => {
  it("reads the two tabs and nothing else", () => {
    expect(parseMattersRoute("#/admin/matters")).toEqual({ tab: "matters" });
    expect(parseMattersRoute(mattersHash("walls"))).toEqual({ tab: "walls" });
    expect(parseMattersRoute("#/admin/vaults")).toBeNull();
    expect(parseMattersRoute("#/library")).toBeNull();
  });
});

describe("MattersApp", () => {
  it("lists matters with their server-formatted display, and searches", async () => {
    adminApi();
    render(<MattersApp onLeave={() => undefined} />);
    expect(await screen.findByText("00123-0001 Acme Corp")).toBeTruthy();
    expect(screen.getByText("Beta dispute")).toBeTruthy();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search matters" }), {
      target: { value: "beta" },
    });
    await waitFor(() => expect(calls.some((c) => c.url === "/api/v1/matters?q=beta")).toBe(true));
  });

  it("adds a matter from the side panel", async () => {
    adminApi((call) =>
      call.method === "POST" && call.url === "/api/v1/matters"
        ? json({ matter: { ...M2, id: "0190a000-0000-7000-8000-0000000000a3" } }, 201)
        : undefined,
    );
    render(<MattersApp onLeave={() => undefined} />);
    fireEvent.click(
      (await screen.findAllByRole("button", { name: "Add matter" }))[0] as HTMLElement,
    );
    const set = (label: string, value: string) =>
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
    set("Client id", "00999");
    set("Client name", "Gamma");
    set("Matter number", "0001");
    set("Matter name", "Gamma deal");
    fireEvent.click(screen.getAllByRole("button", { name: "Add matter" }).at(-1) as HTMLElement);
    await waitFor(() =>
      expect(calls.find((c) => c.method === "POST")?.body).toMatchObject({
        client_id: "00999",
        matter_name: "Gamma deal",
        wall_mode: "open",
      }),
    );
  });

  it("previews a CSV import with its issues before applying it", async () => {
    adminApi((call) => {
      if (call.url === "/api/v1/matters/import") {
        return json({
          token: "0190a000-0000-7000-8000-0000000000d1",
          add: 1,
          update: 0,
          close: 0,
          unchanged: 0,
          issue_count: 1,
          issues: [{ line: 3, column: "matter_number", message: "Doesn't match the pattern." }],
        });
      }
      if (call.url.endsWith("/apply")) {
        return json({ applied: { add: 1, update: 0, close: 0 }, report_csv: "a,result\r\n" });
      }
      return undefined;
    });
    render(<MattersApp onLeave={() => undefined} />);
    fireEvent.click(await screen.findByRole("button", { name: "Import CSV" }));
    fireEvent.change(screen.getByLabelText("CSV file"), {
      target: { files: [new File(["a"], "m.csv")] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    const preview = await screen.findByRole("region", { name: "Import preview" });
    expect(within(preview).getByText(/Line 3 \(matter_number\)/)).toBeTruthy();
    fireEvent.click(within(preview).getByRole("button", { name: "Apply import" }));
    expect(await screen.findByText("Download the result")).toBeTruthy();
  });

  it("edits a matter's notice from its row", async () => {
    adminApi((call) =>
      call.method === "PATCH" ? json({ matter: { ...M1, notice_version: 3 } }) : undefined,
    );
    render(<MattersApp onLeave={() => undefined} />);
    fireEvent.click(await screen.findByText("00123-0001 Acme Corp"));
    const notice = await screen.findByLabelText("Notice");
    fireEvent.change(notice, { target: { value: "New notice" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PATCH")?.body).toMatchObject({
        notice_md: "New notice",
      }),
    );
  });

  it("shows wall rows with provider badges, and only internal rows can be removed", async () => {
    window.location.hash = "#/admin/matters/walls";
    adminApi();
    render(<MattersApp onLeave={() => undefined} />);
    expect(await screen.findByText("corp-team (group)")).toBeTruthy();
    expect(screen.getByText("ben@acme.test (user)")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /^Remove/ })).toHaveLength(1);
    const provider = screen.getByLabelText("Authoritative provider") as HTMLSelectElement;
    const intapp = within(provider).getByRole("option", { name: /Intapp/ }) as HTMLOptionElement;
    expect(intapp.disabled).toBe(true);
  });

  it("previews a walls CSV as a diff, and shows why a file was rejected", async () => {
    window.location.hash = "#/admin/matters/walls";
    adminApi((call) =>
      call.url === "/api/v1/admin/walls/import"
        ? json(
            {
              code: "TOO_MANY_UNRESOLVED",
              message: "More than 10% of the rows couldn't be matched, so nothing was imported.",
              token: null,
              accepted: false,
              matters: 1,
              add: [],
              remove: [],
              unchanged: 0,
              rows: 8,
              unresolved: [
                { line: 4, column: "principal", message: "No user matches this email." },
              ],
            },
            400,
          )
        : undefined,
    );
    render(<MattersApp onLeave={() => undefined} />);
    fireEvent.change(await screen.findByLabelText("Walls file"), {
      target: { files: [new File(["a"], "w.csv")] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(await screen.findByText(/More than 10%/)).toBeTruthy();
    expect(screen.getByText("Line 4: No user matches this email.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Apply walls" })).toBeNull();
  });
});

describe("MatterPicker", () => {
  it("shows an unacknowledged notice before choosing the matter, and records it", async () => {
    serve((call) => {
      if (call.url === "/api/v1/matters?scope=picker") return json({ items: [M1, M2] });
      if (call.url.endsWith("/acknowledge")) {
        return json({ acknowledged_at: "2026-11-21T00:00:00.000Z", notice_version: 2 });
      }
      return undefined;
    });
    const onChange = vi.fn();
    render(<MatterPicker value={null} onChange={onChange} />);
    const select = await screen.findByLabelText("Matter");
    fireEvent.change(select, { target: { value: M1.id } });
    expect(await screen.findByText(/do not discuss with the Beta team/)).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Acknowledge" }));
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ id: M1.id })),
    );
    expect(calls.some((c) => c.url === `/api/v1/matters/${M1.id}/acknowledge`)).toBe(true);
  });

  it("chooses an acknowledged matter straight away", async () => {
    serve((call) =>
      call.url === "/api/v1/matters?scope=picker" ? json({ items: [M1, M2] }) : undefined,
    );
    const onChange = vi.fn();
    render(<MatterPicker value={null} onChange={onChange} />);
    fireEvent.change(await screen.findByLabelText("Matter"), { target: { value: M2.id } });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ id: M2.id }));
  });

  it("stays out of the way when there are no matters to offer", async () => {
    serve(() => json({ items: [] }));
    const { container } = render(<MatterPicker value={null} onChange={() => undefined} />);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(container.textContent).toBe("");
  });
});
