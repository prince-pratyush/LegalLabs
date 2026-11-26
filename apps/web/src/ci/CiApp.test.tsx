import type { CiAgent, CiReview } from "@legallabs/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NoResize } from "../testing.js";
import { CiApp } from "./CiApp.js";
import { ciHash, parseCiRoute } from "./route.js";

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
const AGENT = id(3);
const REVIEW = id(4);
const PLAYBOOK = id(5);
const VERSION = id(6);
const TEAM = id(7);
const PLAYBOOK_REVIEW = id(8);

const agent = (over: Partial<CiAgent> = {}): CiAgent => ({
  id: AGENT,
  name: "MSA intake",
  contract_type: "MSA",
  playbook_id: PLAYBOOK,
  party: "Acme",
  paper: "theirs",
  assignment: [{ kind: "fixed", user_id: ANA }],
  thresholds: { deviates_min_not_acceptable: 2, flag_rule_deviates: true, high_gap_deviates: true },
  status: "draft",
  created_at: "2026-11-10T00:00:00.000Z",
  updated_at: "2026-11-10T00:00:00.000Z",
  ...over,
});

const review = (over: Partial<CiReview> = {}): CiReview => ({
  id: REVIEW,
  agent_id: AGENT,
  agent_name: "MSA intake",
  document_id: id(9),
  document_version_id: VERSION,
  document_name: "Globex MSA.docx",
  playbook_review_id: null,
  run_id: null,
  status: "deviates",
  result: "deviates",
  summary: "Not acceptable: Liability cap.",
  failure: null,
  assignee_id: ME,
  assignee_name: "Me Myself",
  counterparty: "Globex",
  source: { kind: "manual" },
  created_at: "2026-11-10T00:00:00.000Z",
  updated_at: "2026-11-11T00:00:00.000Z",
  done_at: null,
  ...over,
});

type Call = { path: string; params: URLSearchParams; method: string; body: unknown };
let calls: Call[] = [];
type Reply = unknown | [number, unknown];

/** Answers by "METHOD /path"; a [status, body] pair sets the status. */
function serve(routes: Record<string, (call: Call) => Reply>) {
  calls = [];
  const all: Record<string, (call: Call) => Reply> = {
    "GET /auth/session": () => ({ user_id: ME, workspace_id: "w" }),
    "GET /api/v1/apps/ci/dashboard": () => ({
      since_last_visit: 0,
      ready_to_review: 0,
      assigned_to_me: 0,
      as_of: "2026-11-12T00:00:00.000Z",
    }),
    "GET /api/v1/apps/ci/agents": () => ({ agents: [agent({ status: "live" })] }),
    "GET /api/v1/apps/ci/reviews": () => ({ reviews: [], next_cursor: null }),
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
      return new Response(JSON.stringify(body), { status: status as number });
    }),
  );
}

const sent = (method: string, path: string) =>
  calls.filter((c) => c.method === method && c.path === `/api/v1${path}`);
const lastList = () => sent("GET", "/apps/ci/reviews").at(-1)?.params;

function open(hash: string) {
  window.location.hash = hash;
  render(<CiApp onLeave={() => {}} />);
}

const choose = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
const click = (name: string | RegExp) => fireEvent.click(screen.getByRole("button", { name }));

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", NoResize);
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = "";
});

describe("contract routes", () => {
  it("round-trip through the address", () => {
    for (const route of [
      { page: "queue" } as const,
      { page: "agents" } as const,
      { page: "new-agent" } as const,
      { page: "agent", agentId: AGENT } as const,
      { page: "submit", agentId: null } as const,
      { page: "submit", agentId: AGENT } as const,
      { page: "review", reviewId: REVIEW } as const,
    ]) {
      expect(parseCiRoute(ciHash(route))).toEqual(route);
    }
    expect(parseCiRoute("#/reviews/x")).toBeNull();
    expect(parseCiRoute("#/ci/nothing")).toBeNull();
  });
});

describe("the contract queue", () => {
  it("shows the counters, and what was reviewed since the last visit", async () => {
    serve({
      "GET /api/v1/apps/ci/dashboard": (c) => ({
        since_last_visit: c.params.get("since") ? 2 : 0,
        ready_to_review: 5,
        assigned_to_me: 3,
        as_of: "2026-11-12T00:00:00.000Z",
      }),
    });
    open("#/ci");
    const ready = await screen.findByRole("region", { name: "Ready to review" });
    await waitFor(() => expect(ready.textContent).toContain("5"));
    expect(screen.getByRole("region", { name: "Assigned to you" }).textContent).toContain("3");
    expect(screen.queryByText(/since your last visit/)).toBeNull();

    cleanup();
    render(<CiApp onLeave={() => {}} />);
    expect(await screen.findByText("Reviewed 2 contracts since your last visit")).toBeTruthy();
    expect(sent("GET", "/apps/ci/dashboard").at(-1)?.params.get("since")).toBe(
      "2026-11-12T00:00:00.000Z",
    );
  });

  it("lists my reviews first, then all of them", async () => {
    serve({
      "GET /api/v1/apps/ci/reviews": () => ({ reviews: [review()], next_cursor: null }),
    });
    open("#/ci");
    const link = await screen.findByRole("link", { name: "Globex MSA.docx" });
    expect(link.getAttribute("href")).toBe(`#/ci/reviews/${REVIEW}`);
    const table = screen.getByRole("table", { name: "Contract reviews" });
    for (const text of ["Deviates", "Not acceptable: Liability cap.", "Globex", "Me Myself"]) {
      expect(within(table).getByText(text)).toBeTruthy();
    }
    expect(lastList()?.get("filter[assignee_id]")).toBe("me");
    expect(screen.queryByLabelText("Assignee")).toBeNull();

    fireEvent.mouseDown(screen.getByRole("tab", { name: "All" }));
    await waitFor(() => expect(lastList()?.has("filter[assignee_id]")).toBe(false));
    expect(screen.getByLabelText("Assignee")).toBeTruthy();
  });

  it("filters by status, agent, assignee, counterparty and date", async () => {
    serve({
      "GET /api/v1/apps/ci/reviews": () => ({
        reviews: [review({ assignee_id: ANA, assignee_name: "Ana Silva" })],
        next_cursor: null,
      }),
    });
    open("#/ci");
    fireEvent.mouseDown(await screen.findByRole("tab", { name: "All" }));
    await screen.findByRole("option", { name: "Ana Silva" });
    choose("Status", "needs_review");
    choose("Agent", AGENT);
    choose("Assignee", ANA);
    choose("Counterparty", "glob");
    choose("Changed from", "2026-11-01");
    choose("Changed to", "2026-11-30");
    await waitFor(() => expect(lastList()?.get("filter[counterparty]")).toBe("glob"));
    await waitFor(() => expect(lastList()?.get("filter[to]")).toBeTruthy());
    expect(lastList()?.get("filter[status]")).toBe("needs_review");
    expect(lastList()?.get("filter[agent_id]")).toBe(AGENT);
    expect(lastList()?.get("filter[assignee_id]")).toBe(ANA);
    // Both days are included, in the reader's own time zone.
    expect(lastList()?.get("filter[from]")).toBe(new Date(2026, 10, 1).toISOString());
    expect(lastList()?.get("filter[to]")).toBe(new Date(2026, 11, 1).toISOString());
  });

  it("says when nothing is waiting, and when a filter matches nothing", async () => {
    serve({});
    open("#/ci");
    expect(await screen.findByText("Nothing is assigned to you")).toBeTruthy();
    choose("Status", "failed");
    expect(await screen.findByText("No reviews match")).toBeTruthy();
    click("Clear filters");
    expect(await screen.findByText("Nothing is assigned to you")).toBeTruthy();
  });

  it("loads further pages", async () => {
    serve({
      "GET /api/v1/apps/ci/reviews": (c) =>
        c.params.get("cursor")
          ? {
              reviews: [review({ id: id(20), document_name: "Second.docx" })],
              next_cursor: null,
            }
          : { reviews: [review()], next_cursor: "next" },
    });
    open("#/ci");
    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
    expect(await screen.findByRole("link", { name: "Second.docx" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Globex MSA.docx" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("shows why the queue could not load", async () => {
    serve({
      "GET /api/v1/apps/ci/reviews": () => [403, { code: "FORBIDDEN", message: "Not for you." }],
    });
    open("#/ci");
    expect((await screen.findByRole("alert")).textContent).toBe("Not for you.");
  });
});

const one = (over: Partial<CiReview> = {}) => ({
  [`GET /api/v1/apps/ci/reviews/${REVIEW}`]: () => ({ review: review(over) }),
});

describe("a contract review", () => {
  it("says so when there is no such review", async () => {
    serve({});
    open(`#/ci/reviews/${REVIEW}`);
    expect(await screen.findByText("Review not found")).toBeTruthy();
    click("Back to the queue");
    expect(window.location.hash).toBe("#/ci");
  });

  it("shows the outcome above the playbook review, and lets the assignee finish it", async () => {
    serve({
      ...one({ playbook_review_id: PLAYBOOK_REVIEW }),
      "GET /api/v1/apps/ci/agents": () => ({ agents: [] }),
      [`GET /api/v1/reviews/${PLAYBOOK_REVIEW}`]: () => [
        404,
        { code: "NOT_FOUND", message: "The result is gone." },
      ],
      [`POST /api/v1/apps/ci/reviews/${REVIEW}/status`]: () => ({
        review: review({ status: "done", done_at: "2026-11-12T00:00:00.000Z" }),
      }),
    });
    open(`#/ci/reviews/${REVIEW}`);
    expect(await screen.findByText("Not acceptable: Liability cap.")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Globex MSA.docx");
    // The playbook result view asks for its own review.
    expect(await screen.findByText("The result is gone.")).toBeTruthy();
    // Only the agent's owner runs it again.
    expect(screen.queryByRole("button", { name: "Run again" })).toBeNull();
    click("Mark done");
    await waitFor(() =>
      expect(sent("POST", `/apps/ci/reviews/${REVIEW}/status`)[0]?.body).toEqual({
        status: "done",
      }),
    );
    expect(await screen.findByText("Done")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Mark done" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reassign" })).toBeNull();
  });

  it("is handed on to someone found by email, and shows a refusal", async () => {
    let allowed = false;
    serve({
      ...one(),
      "GET /api/v1/library/principals": () => ({
        principals: [
          { principal_type: "user", principal_id: ANA, label: "ana@acme.test" },
          { principal_type: "group", principal_id: TEAM, label: "ana team" },
        ],
      }),
      [`POST /api/v1/apps/ci/reviews/${REVIEW}/assign`]: () =>
        allowed
          ? { review: review({ assignee_id: ANA, assignee_name: "Ana Silva" }) }
          : [422, { code: "ASSIGNEE_NOT_ALLOWED", message: "That person can't open it." }],
    });
    open(`#/ci/reviews/${REVIEW}`);
    fireEvent.click(await screen.findByRole("button", { name: "Reassign" }));
    choose("Find a person", "ana");
    fireEvent.click(await screen.findByRole("button", { name: "ana@acme.test" }));
    expect((await screen.findByRole("alert")).textContent).toBe("That person can't open it.");
    expect(screen.queryByRole("button", { name: "ana team" })).toBeNull();
    allowed = true;
    fireEvent.click(screen.getByRole("button", { name: "ana@acme.test" }));
    expect(await screen.findByText(/Assigned to Ana Silva/)).toBeTruthy();
    expect(sent("POST", `/apps/ci/reviews/${REVIEW}/assign`).at(-1)?.body).toEqual({
      assignee_id: ANA,
    });
  });

  it("explains a failure and lets the owner run it again", async () => {
    let status: CiReview["status"] = "failed";
    serve({
      [`GET /api/v1/apps/ci/reviews/${REVIEW}`]: () => ({
        review: review({
          status,
          result: null,
          summary: null,
          failure: status === "failed" ? "REVIEW_FAILED" : null,
        }),
      }),
      [`POST /api/v1/apps/ci/reviews/${REVIEW}/rerun`]: () => {
        status = "queued";
        return [202, { review_id: REVIEW }];
      },
    });
    open(`#/ci/reviews/${REVIEW}`);
    expect(await screen.findByText("The review stopped before it finished.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Mark done" })).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Run again" }));
    expect(await screen.findByText("Waiting for its turn to be reviewed.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Run again" })).toBeNull();
  });
});

const principals = () => ({
  principals: [
    { principal_type: "user", principal_id: ANA, label: "ana@acme.test" },
    { principal_type: "group", principal_id: TEAM, label: "Legal team" },
  ],
});
const playbooks = () => ({
  playbooks: [{ id: PLAYBOOK, name: "Customer MSA", contract_type: "MSA", status: "published" }],
});

describe("review agents", () => {
  it("are listed with their status, and an empty list offers to build one", async () => {
    serve({ "GET /api/v1/apps/ci/agents": () => ({ agents: [] }) });
    open("#/ci/agents");
    fireEvent.click(await screen.findByRole("button", { name: "New review agent" }));
    expect(window.location.hash).toBe("#/ci/agents/new");
  });

  it("are built from a form", async () => {
    serve({
      "GET /api/v1/playbooks": playbooks,
      "GET /api/v1/library/principals": principals,
      "POST /api/v1/apps/ci/agents": () => [201, { agent: agent() }],
      [`GET /api/v1/apps/ci/agents/${AGENT}`]: () => ({
        agent: agent(),
        names: { [ANA]: "ana@acme.test" },
      }),
    });
    open("#/ci/agents/new");
    await screen.findByRole("option", { name: "Customer MSA" });
    click("Create agent");
    expect((await screen.findByRole("alert")).textContent).toContain("name");
    expect(sent("POST", "/apps/ci/agents")).toHaveLength(0);

    choose("Name", "MSA intake");
    choose("Contract type", "MSA");
    choose("Playbook", PLAYBOOK);
    choose("Party we act for", "Acme");

    // A round robin over a group, then a rule on the contract's value.
    click("Add rule");
    choose("Rule 1", "round_robin");
    choose("Find a group", "leg");
    fireEvent.click(await screen.findByRole("button", { name: "Legal team" }));
    click("Add rule");
    choose("Rule 2", "field");
    choose("Field", "contract_value");
    choose("Condition", "gt");
    choose("Value", "100000");
    choose("Find a person or group", "ana");
    fireEvent.click(await screen.findByRole("button", { name: "ana@acme.test" }));
    choose("Not acceptable rules that make a contract deviate", "3");
    click("Create agent");

    await waitFor(() => expect(window.location.hash).toBe(`#/ci/agents/${AGENT}`));
    expect(sent("POST", "/apps/ci/agents")[0]?.body).toEqual({
      name: "MSA intake",
      contract_type: "MSA",
      playbook_id: PLAYBOOK,
      party: "Acme",
      paper: "theirs",
      assignment: [
        { kind: "round_robin", group_id: TEAM },
        {
          kind: "field",
          field: "contract_value",
          cases: [{ op: "gt", value: 100000, assignee: { user_id: ANA } }],
        },
      ],
      thresholds: {
        deviates_min_not_acceptable: 3,
        flag_rule_deviates: true,
        high_gap_deviates: true,
      },
    });
  });

  it("are changed, activated and paused", async () => {
    let current = agent();
    serve({
      "GET /api/v1/playbooks": playbooks,
      [`GET /api/v1/apps/ci/agents/${AGENT}`]: () => ({
        agent: current,
        names: { [ANA]: "ana@acme.test" },
      }),
      [`PATCH /api/v1/apps/ci/agents/${AGENT}`]: (c) => {
        current = agent({ ...(c.body as Partial<CiAgent>) });
        return { agent: current };
      },
      [`POST /api/v1/apps/ci/agents/${AGENT}/activate`]: () => {
        current = { ...current, status: "live" };
        return { agent: current };
      },
      [`POST /api/v1/apps/ci/agents/${AGENT}/deactivate`]: () => {
        current = { ...current, status: "paused" };
        return { agent: current };
      },
    });
    open(`#/ci/agents/${AGENT}`);
    // The saved rule shows who it points at.
    expect(await screen.findByText("ana@acme.test")).toBeTruthy();
    await screen.findByRole("option", { name: "Customer MSA" });
    const page = within(screen.getByRole("main"));
    expect(page.queryByRole("button", { name: "Submit a contract" })).toBeNull();
    choose("Name", "Supplier MSAs");
    click("Save changes");
    await waitFor(() =>
      expect(sent("PATCH", `/apps/ci/agents/${AGENT}`)[0]?.body).toMatchObject({
        name: "Supplier MSAs",
        assignment: [{ kind: "fixed", user_id: ANA }],
      }),
    );
    click("Activate");
    fireEvent.click(await page.findByRole("button", { name: "Submit a contract" }));
    expect(window.location.hash).toBe(`#/ci/submit?agent=${AGENT}`);
  });

  it("says so when there is no such agent", async () => {
    serve({ "GET /api/v1/playbooks": playbooks });
    open(`#/ci/agents/${AGENT}`);
    expect(await screen.findByText("Review agent not found")).toBeTruthy();
  });
});

describe("submitting a contract", () => {
  const documents = () => ({
    documents: [
      {
        id: id(30),
        version_id: VERSION,
        name: "Globex MSA.docx",
        mime: "application/pdf",
        status: "indexed",
      },
    ],
  });

  it("queues it with what the rules can match on", async () => {
    serve({
      "GET /api/v1/documents": documents,
      "POST /api/v1/apps/ci/reviews": () => [201, { review_id: REVIEW }],
    });
    open(`#/ci/submit?agent=${AGENT}`);
    await screen.findByRole("option", { name: "Globex MSA.docx" });
    choose("Contract", VERSION);
    choose("Counterparty", "Globex");
    choose("Governing law", "DE");
    choose("Contract value", "5000");
    click("Submit for review");
    await waitFor(() => expect(window.location.hash).toBe(`#/ci/reviews/${REVIEW}`));
    expect(sent("POST", "/apps/ci/reviews")[0]?.body).toEqual({
      agent_id: AGENT,
      document_version_id: VERSION,
      counterparty: "Globex",
      fields: { governing_law: "DE", contract_value: 5000 },
    });
  });

  it("offers to build an agent when none is live", async () => {
    serve({
      "GET /api/v1/documents": documents,
      "GET /api/v1/apps/ci/agents": () => ({ agents: [agent()] }),
    });
    open("#/ci/submit");
    fireEvent.click(await screen.findByRole("button", { name: "Review agents" }));
    expect(window.location.hash).toBe("#/ci/agents");
  });
});
