import type { IntakeEvent, IntakeRequest, IntakeType } from "@legallabs/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NoResize } from "../testing.js";
import { IntakeApp } from "./IntakeApp.js";
import { intakeHash, parseIntakeRoute } from "./route.js";

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
const ME = id(1);
const ANA = id(2);
const TYPE = id(3);
const REQUEST = id(4);
const DOCUMENT = id(5);

const type = (over: Partial<IntakeType> = {}): IntakeType => ({
  id: TYPE,
  name: "NDA",
  description: "",
  fields: [
    { key: "counterparty", label: "Counterparty", type: "text", required: true, prompt: "" },
    { key: "mutual", label: "Mutual?", type: "boolean", required: true, prompt: "" },
  ],
  routing: null,
  default_owners: [],
  reviewers: [],
  escalations: [],
  sla_hours: 8,
  awaiting_requester_timeout_hours: 72,
  keyword_rules: [],
  created_at: "2026-11-10T00:00:00.000Z",
  updated_at: "2026-11-10T00:00:00.000Z",
  ...over,
});

const request = (over: Partial<IntakeRequest> = {}): IntakeRequest => ({
  id: REQUEST,
  number: 1042,
  channel: "api",
  external_ref: "ref-1",
  requester: { display_name: "Jo Smith", email: "jo@acme.example", external_user_id: "jo" },
  type_id: TYPE,
  type_name: "NDA",
  fields: { counterparty: "Acme" },
  missing_fields: ["mutual"],
  status: "new",
  closed_reason: null,
  assignee_id: null,
  assignee_name: null,
  matter_id: null,
  sla: { due_at: "2026-11-10T08:00:00.000Z", state: "breached" },
  created_at: "2026-11-10T00:00:00.000Z",
  updated_at: "2026-11-10T00:00:00.000Z",
  ...over,
});

const event = (over: Partial<IntakeEvent> = {}): IntakeEvent => ({
  id: id(20),
  at: "2026-11-10T00:00:00.000Z",
  kind: "inbound",
  actor_type: "user",
  actor_id: ME,
  actor_name: "Me Myself",
  details: { channel: "api", attachments: 1 },
  ...over,
});

const detail = (over: Partial<IntakeRequest> = {}) => ({
  request: {
    ...request(over),
    attachments: [{ document_id: DOCUMENT, name: "draft.docx", size: 10, state: "indexed" }],
  },
});

type Call = { path: string; params: URLSearchParams; method: string; body: unknown };
let calls: Call[] = [];
type Reply = unknown | [number, unknown];

/** Answers by "METHOD /path"; a [status, body] pair sets the status. */
function serve(routes: Record<string, (call: Call) => Reply> = {}) {
  calls = [];
  const all: Record<string, (call: Call) => Reply> = {
    "GET /api/v1/apps/intake/request-types": () => ({ types: [type()], can_manage: true }),
    "GET /api/v1/apps/intake/requests": () => ({ requests: [request()], next_cursor: null }),
    [`GET /api/v1/apps/intake/requests/${REQUEST}`]: () => detail(),
    [`GET /api/v1/apps/intake/requests/${REQUEST}/audit`]: () => ({ events: [event()] }),
    [`GET /api/v1/apps/intake/requests/${REQUEST}/assignees`]: () => ({
      people: [{ id: ANA, name: "Ana Silva" }],
    }),
    ...routes,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const [path = "", query = ""] = url.split("?");
      const call = {
        path,
        params: new URLSearchParams(query),
        method: init.method ?? "GET",
        body: typeof init.body === "string" ? JSON.parse(init.body) : null,
      };
      calls.push(call);
      const found = all[`${call.method} ${path}`]?.(call);
      if (found === undefined) {
        return new Response(JSON.stringify({ code: "NOT_FOUND", message: "No." }), { status: 404 });
      }
      const [status, body] = Array.isArray(found) ? found : [200, found];
      if (status === 204) return new Response(null, { status: 204 });
      return new Response(JSON.stringify(body), { status: status as number });
    }),
  );
}

const sent = (method: string, path: string) =>
  calls.filter((c) => c.method === method && c.path === `/api/v1${path}`);
const lastList = () => sent("GET", "/apps/intake/requests").at(-1)?.params;

function open(hash: string) {
  window.location.hash = hash;
  return render(<IntakeApp onLeave={() => {}} />);
}

const choose = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
const click = (name: string | RegExp) => fireEvent.click(screen.getByRole("button", { name }));
const openRequest = () => open(`#/intake/requests/${REQUEST}`);

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", NoResize);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = "";
});

describe("intake routes", () => {
  it("round-trip through the address", () => {
    for (const route of [
      { page: "queue" } as const,
      { page: "request", requestId: REQUEST } as const,
      { page: "types" } as const,
      { page: "new-type" } as const,
      { page: "type", typeId: TYPE } as const,
    ]) {
      expect(parseIntakeRoute(intakeHash(route))).toEqual(route);
    }
    expect(parseIntakeRoute("#/ci")).toBeNull();
    expect(parseIntakeRoute("#/intake/nothing")).toBeNull();
    expect(parseIntakeRoute("#/intake/requests/%E0%A4%A")).toBeNull();
  });
});

describe("the triage queue", () => {
  it("lists open requests with their SLA state", async () => {
    serve();
    open("#/intake");
    const link = await screen.findByRole("link", { name: "#1042" });
    expect(link.getAttribute("href")).toBe(`#/intake/requests/${REQUEST}`);
    const table = screen.getByRole("table", { name: "Intake requests" });
    for (const text of ["NDA", "Jo Smith", "Manual", "New", "Breached", "Unassigned"]) {
      expect(within(table).getByText(text)).toBeTruthy();
    }
    expect(lastList()?.get("filter[status]")).toBe("open");
  });

  it("filters by status, type, channel and who has them", async () => {
    serve();
    open("#/intake");
    await screen.findByRole("link", { name: "#1042" });
    choose("Status", "closed");
    choose("Type", TYPE);
    choose("Channel", "email");
    choose("Assignee", "me");
    await waitFor(() => expect(lastList()?.get("filter[assignee_id]")).toBe("me"));
    expect(lastList()?.get("filter[status]")).toBe("closed");
    expect(lastList()?.get("filter[type_id]")).toBe(TYPE);
    expect(lastList()?.get("filter[channel]")).toBe("email");
    choose("Status", "");
    await waitFor(() => expect(lastList()?.has("filter[status]")).toBe(false));
  });

  it("says when the queue is empty, and when a filter matches nothing", async () => {
    serve({ "GET /api/v1/apps/intake/requests": () => ({ requests: [], next_cursor: null }) });
    open("#/intake");
    expect(await screen.findByText("No open requests")).toBeTruthy();
    choose("Status", "done");
    expect(await screen.findByText("No requests match")).toBeTruthy();
    click("Clear filters");
    expect(await screen.findByText("No open requests")).toBeTruthy();
  });

  it("loads further pages", async () => {
    serve({
      "GET /api/v1/apps/intake/requests": (c) =>
        c.params.get("cursor")
          ? { requests: [request({ id: id(30), number: 1 })], next_cursor: null }
          : { requests: [request()], next_cursor: "1042" },
    });
    open("#/intake");
    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
    expect(await screen.findByRole("link", { name: "#1" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "#1042" })).toBeTruthy();
  });

  it("tells someone without triage that the queue isn't theirs", async () => {
    serve({
      "GET /api/v1/apps/intake/requests": () => [403, { code: "FORBIDDEN", message: "No." }],
    });
    open("#/intake");
    expect(await screen.findByText("You can't see the intake queue")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });
});

describe("a request", () => {
  it("shows the requester, fields, what is missing, files and the timeline", async () => {
    serve({
      [`GET /api/v1/apps/intake/requests/${REQUEST}/audit`]: () => ({
        events: [
          event(),
          event({ id: id(21), kind: "status", details: { from: "new", to: "triaged" } }),
        ],
      }),
    });
    openRequest();
    expect(await screen.findByRole("heading", { name: "Request #1042" })).toBeTruthy();
    expect(screen.getByText("jo@acme.example")).toBeTruthy();
    expect(screen.getByText("Acme")).toBeTruthy();
    expect(screen.getByText("Still missing: Mutual?")).toBeTruthy();
    expect(screen.getByRole("link", { name: "draft.docx" }).getAttribute("href")).toBe(
      `/d/${DOCUMENT}/v/1`,
    );
    const timeline = await screen.findByRole("list", { name: "Timeline" });
    expect(within(timeline).getByText("Received")).toBeTruthy();
    expect(within(timeline).getByText("Status changed from New to Triaged")).toBeTruthy();
    expect(within(timeline).getAllByText(/Me Myself/)).toHaveLength(2);
  });

  it("names the requester, not the system, for what arrived from outside", async () => {
    serve({
      [`GET /api/v1/apps/intake/requests/${REQUEST}/audit`]: () => ({
        events: [event({ actor_type: "requester", actor_id: null, actor_name: null })],
      }),
    });
    openRequest();
    const timeline = await screen.findByRole("list", { name: "Timeline" });
    expect(await within(timeline).findByText(/^Requester ·/)).toBeTruthy();
    expect(within(timeline).queryByText(/System/)).toBeNull();
  });

  it("shows what a requester sent as text only: no markup and no links", async () => {
    const hostile = '<img src=x onerror="alert(1)">';
    serve({
      [`GET /api/v1/apps/intake/requests/${REQUEST}`]: () => ({
        request: {
          ...request({
            requester: {
              display_name: hostile,
              email: "javascript:alert(1)",
              external_user_id: "x",
            },
            fields: {
              counterparty: "javascript:alert(document.cookie)",
              note: "[click](data:text/html,x) https://evil.example",
            },
            status: "closed",
            closed_reason: "<script>alert(2)</script>",
          }),
          attachments: [{ document_id: DOCUMENT, name: hostile, size: 1, state: "failed" }],
        },
      }),
    });
    const { container } = openRequest();
    expect(await screen.findByText("javascript:alert(document.cookie)")).toBeTruthy();
    expect(screen.getByText("[click](data:text/html,x) https://evil.example")).toBeTruthy();
    expect(screen.getAllByText(hostile, { exact: false }).length).toBeGreaterThan(0);
    expect(screen.getByText(/<script>alert\(2\)<\/script>/)).toBeTruthy();
    expect(container.querySelector("img, script, iframe")).toBeNull();
    for (const link of container.querySelectorAll("a")) {
      expect(link.getAttribute("href")).toMatch(/^[#/]/);
      expect(link.textContent).not.toContain("javascript:");
    }
  });

  it("assigns to someone who can take it", async () => {
    serve({
      [`POST /api/v1/apps/intake/requests/${REQUEST}/assign`]: () =>
        detail({ assignee_id: ANA, assignee_name: "Ana Silva" }),
    });
    openRequest();
    await screen.findByRole("option", { name: "Ana Silva" });
    choose("Assignee", ANA);
    await waitFor(() =>
      expect(sent("POST", `/apps/intake/requests/${REQUEST}/assign`)[0]?.body).toEqual({
        assignee_id: ANA,
      }),
    );
    expect(await screen.findByText("Assigned to Ana Silva")).toBeTruthy();
    // The timeline is read again after a change.
    await waitFor(() =>
      expect(sent("GET", `/apps/intake/requests/${REQUEST}/audit`).length).toBeGreaterThan(1),
    );
  });

  it("changes type", async () => {
    serve({
      "GET /api/v1/apps/intake/request-types": () => ({
        types: [type(), type({ id: id(40), name: "Vendor review" })],
        can_manage: false,
      }),
      [`POST /api/v1/apps/intake/requests/${REQUEST}/type`]: () =>
        detail({ type_id: id(40), type_name: "Vendor review" }),
    });
    openRequest();
    await screen.findByRole("option", { name: "Vendor review" });
    choose("Request type", id(40));
    await waitFor(() =>
      expect(sent("POST", `/apps/intake/requests/${REQUEST}/type`)[0]?.body).toEqual({
        type_id: id(40),
      }),
    );
  });

  it("offers only the next statuses, and asks why when closing", async () => {
    serve({
      [`POST /api/v1/apps/intake/requests/${REQUEST}/status`]: () =>
        detail({ status: "closed", closed_reason: "Duplicate" }),
    });
    openRequest();
    await screen.findByRole("button", { name: "Mark triaged" });
    expect(screen.queryByRole("button", { name: "Mark done" })).toBeNull();
    click("Close…");
    const confirm = screen.getByRole("button", { name: "Close request" });
    expect(confirm.hasAttribute("disabled")).toBe(true);
    choose("Why is it being closed?", "  Duplicate ");
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(sent("POST", `/apps/intake/requests/${REQUEST}/status`)[0]?.body).toEqual({
        status: "closed",
        reason: "Duplicate",
      }),
    );
    expect(await screen.findByText("Closed: Duplicate")).toBeTruthy();
    // Finished: nothing left to change.
    expect(screen.queryByLabelText("Assignee")).toBeNull();
    expect(screen.queryByLabelText("Request type")).toBeNull();
    expect(screen.queryByRole("button", { name: "Close…" })).toBeNull();
  });

  it("shows why a change was refused", async () => {
    serve({
      [`POST /api/v1/apps/intake/requests/${REQUEST}/status`]: () => [
        409,
        { code: "TYPE_REQUIRED", message: "Give the request a type first." },
      ],
    });
    openRequest();
    fireEvent.click(await screen.findByRole("button", { name: "Mark triaged" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Give the request a type first.");
  });

  it("says when it can't be found", async () => {
    serve({ [`GET /api/v1/apps/intake/requests/${REQUEST}`]: () => undefined });
    openRequest();
    expect(await screen.findByText("Request not found")).toBeTruthy();
  });
});

describe("request type settings", () => {
  it("lists types, and offers no changes to someone who can't manage them", async () => {
    serve({
      "GET /api/v1/apps/intake/request-types": () => ({ types: [type()], can_manage: false }),
    });
    open("#/intake/types");
    expect(await screen.findByText("NDA")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "New request type" })).toBeNull();
    expect(screen.queryByRole("link", { name: "NDA" })).toBeNull();
  });

  it("creates a type with its fields", async () => {
    serve({
      "POST /api/v1/apps/intake/request-types": () => [201, { type: type() }],
    });
    open("#/intake/types/new");
    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: " Vendor " } });
    choose("Hours to resolve", "24");
    click("Add field");
    choose("Field label", "Contract value (USD)");
    choose("Field kind", "money");
    click("Add field");
    fireEvent.change(screen.getAllByLabelText("Field label")[1] as HTMLElement, {
      target: { value: "Region" },
    });
    fireEvent.change(screen.getAllByLabelText("Field kind")[1] as HTMLElement, {
      target: { value: "select" },
    });
    choose("Choices, one per line", "EU\n US \n\n");
    choose("Keywords that pick this type, one per line", "vendor\n");
    click("Save");
    await waitFor(() => expect(sent("POST", "/apps/intake/request-types")).toHaveLength(1));
    expect(sent("POST", "/apps/intake/request-types")[0]?.body).toEqual({
      name: "Vendor",
      description: "",
      sla_hours: 24,
      awaiting_requester_timeout_hours: 72,
      keyword_rules: ["vendor"],
      fields: [
        {
          key: "contract_value_usd",
          label: "Contract value (USD)",
          type: "money",
          required: false,
          prompt: "",
        },
        {
          key: "region",
          label: "Region",
          type: "select",
          required: false,
          prompt: "",
          options: ["EU", "US"],
        },
      ],
    });
    await waitFor(() => expect(window.location.hash).toBe("#/intake/types"));
  });

  it("says what is wrong before sending", async () => {
    serve();
    open("#/intake/types/new");
    await screen.findByLabelText("Name");
    click("Save");
    expect(screen.getByRole("alert").textContent).toBe("Give the type a name.");
    choose("Name", "x");
    click("Add field");
    click("Save");
    expect(screen.getByRole("alert").textContent).toBe("Give every field a label.");
    expect(sent("POST", "/apps/intake/request-types")).toHaveLength(0);
  });

  it("keeps field keys, routing and escalations when editing", async () => {
    const routed = type({
      routing: { kind: "contract_intelligence", ci_agent_id: id(50) },
      escalations: [{ when: [{ sla: "breached" }], action: "notify", target: { user_id: ANA } }],
    });
    serve({
      "GET /api/v1/apps/intake/request-types": () => ({ types: [routed], can_manage: true }),
      [`PATCH /api/v1/apps/intake/request-types/${TYPE}`]: () => ({ type: routed }),
    });
    open(`#/intake/types/${TYPE}`);
    const labels = await screen.findAllByLabelText("Field label");
    fireEvent.change(labels[0] as HTMLElement, { target: { value: "Other side" } });
    click("Save");
    await waitFor(() =>
      expect(sent("PATCH", `/apps/intake/request-types/${TYPE}`)).toHaveLength(1),
    );
    const body = sent("PATCH", `/apps/intake/request-types/${TYPE}`)[0]?.body as Record<
      string,
      unknown
    >;
    expect((body.fields as { key: string }[]).map((f) => f.key)).toEqual([
      "counterparty",
      "mutual",
    ]);
    expect(body).not.toHaveProperty("routing");
    expect(body).not.toHaveProperty("escalations");
  });

  it("removes a type after asking", async () => {
    serve({ [`DELETE /api/v1/apps/intake/request-types/${TYPE}`]: () => [204, null] });
    open(`#/intake/types/${TYPE}`);
    fireEvent.click(await screen.findByRole("button", { name: "Remove type" }));
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
    await waitFor(() =>
      expect(sent("DELETE", `/apps/intake/request-types/${TYPE}`)).toHaveLength(1),
    );
    await waitFor(() => expect(window.location.hash).toBe("#/intake/types"));
  });
});
