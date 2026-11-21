import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App.js";
import { at, FakeSource, type Handler, serve } from "../testing.js";
import type { Agent, AgentVersion } from "./api.js";
import { type AgentRoute, agentHash, parseAgentRoute } from "./route.js";

const ME = "0190a000-0000-7000-8000-0000000000e1";
const ID = "0190a000-0000-7000-8000-0000000000a1";
const LIVE = "0190a000-0000-7000-8000-0000000000b1";
const DRAFT = "0190a000-0000-7000-8000-0000000000b2";
const RUN = "0190a000-0000-7000-8000-0000000000c1";
const THREAD = "0190a000-0000-7000-8000-0000000000d1";

const agent = (over: Partial<Agent> = {}): Agent => ({
  id: ID,
  owner_id: ME,
  title: "NDA first pass",
  description: "Reviews NDAs.",
  practice_areas: ["Commercial"],
  status: "live",
  live_version_id: LIVE,
  draft_version_id: null,
  auto_description: false,
  my_access: "full",
  created_at: "2026-11-01T00:00:00.000Z",
  updated_at: "2026-11-02T00:00:00.000Z",
  stats: { runs: 3, test_runs: 1, last_run_at: null },
  schedule: null,
  ...over,
});

const version = (id: string, no: number, instructions: string): AgentVersion => ({
  id,
  agent_id: ID,
  no,
  instructions,
  attachments: [],
  sources: [],
  created_by: ME,
  created_at: "2026-11-02T00:00:00.000Z",
});

const runRow = (status = "running") => ({
  id: RUN,
  kind: "agent",
  status,
  thread_id: THREAD,
  question_id: "q",
  message_id: null,
  coverage: null,
  plan: null,
  model: null,
  cost_usd: 0,
});

const base: Record<string, Handler> = {
  "GET /auth/session": () => [200, { user_id: ME, workspace_id: "w" }],
  "GET /api/v1/agents": () => [200, { agents: [agent()] }],
  [`GET /api/v1/agents/${ID}`]: () => [200, { agent: agent() }],
  [`GET /api/v1/agents/${ID}/versions`]: () => [
    200,
    { versions: [version(LIVE, 1, "Review the NDA.")] },
  ],
  "GET /api/v1/documents": () => [200, { documents: [] }],
  "GET /api/v1/scope-options": () => [200, { vaults: [], sources: [], models: [] }],
  "GET /api/v1/members": () => [200, { items: [{ id: "u2", email: "sam@x.test", name: "Sam" }] }],
  [`GET /api/v1/runs/${RUN}`]: () => [200, { run: runRow() }],
};

const stream = () => {
  const found = FakeSource.all.find((s) => s.url.includes(`/runs/${RUN}/events`) && s.open);
  if (!found) throw new Error("no stream");
  return found;
};

class Channel {
  static sent: unknown[] = [];
  static live: Channel[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor(readonly name: string) {
    Channel.live.push(this);
  }
  postMessage(data: unknown) {
    Channel.sent.push(data);
    for (const c of Channel.live)
      if (c !== this) c.onmessage?.(new MessageEvent("message", { data }));
  }
  close() {
    Channel.live = Channel.live.filter((c) => c !== this);
  }
}

beforeEach(() => {
  Channel.sent = [];
  Channel.live = [];
  vi.stubGlobal("BroadcastChannel", Channel);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("agent routes", () => {
  it("round-trip through the address", () => {
    const routes: AgentRoute[] = [
      { page: "list" },
      { page: "agent", agentId: ID, tab: "instructions" },
      { page: "agent", agentId: ID, tab: "activity" },
      { page: "build", agentId: ID },
      { page: "test", agentId: ID, version: DRAFT },
      { page: "test", agentId: ID, version: null },
      { page: "run", agentId: ID, runId: RUN },
      { page: "requests" },
      { page: "approvals" },
    ];
    for (const route of routes) expect(parseAgentRoute(agentHash(route))).toEqual(route);
    expect(parseAgentRoute("#/playbooks")).toBeNull();
  });
});

describe("agents list", () => {
  it("filters, searches and shows access for shared agents", async () => {
    const shared = agent({ id: "x2", title: "Lease digest", owner_id: "other", my_access: "run" });
    const sent = serve({
      ...base,
      "GET /api/v1/agents": () => [200, { agents: [agent(), shared] }],
      "GET /api/v1/agents?filter%5Bowner%5D=shared": () => [200, { agents: [shared] }],
      "GET /api/v1/agents?filter%5Bpractice_area%5D=Commercial&q=nda": () => [
        200,
        { agents: [agent()] },
      ],
    });
    at("#/agents");
    render(<App />);
    const list = await screen.findByRole("list", { name: "Agents" });
    expect(within(list).getByText("Lease digest")).toBeTruthy();
    expect(within(list).getByText("Can run")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Shared with me" }));
    await waitFor(() =>
      expect(sent.some((c) => c.route === "GET /api/v1/agents?filter%5Bowner%5D=shared")).toBe(
        true,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    fireEvent.change(await screen.findByRole("combobox", { name: "Practice area" }), {
      target: { value: "Commercial" },
    });
    fireEvent.change(screen.getByLabelText("Search agents"), { target: { value: "nda" } });
    await waitFor(() =>
      expect(
        sent.some(
          (c) => c.route === "GET /api/v1/agents?filter%5Bpractice_area%5D=Commercial&q=nda",
        ),
      ).toBe(true),
    );
  });

  it("starts an agent by describing it", async () => {
    const sent = serve({
      ...base,
      "GET /api/v1/agents": () => [200, { agents: [] }],
      "POST /api/v1/agents": () => [
        201,
        { agent: agent({ status: "draft", live_version_id: null }) },
      ],
      [`GET /api/v1/runs?filter%5Bkind%5D=agent_builder&filter%5Bsubject_id%5D=${ID}&limit=1`]:
        () => [200, { runs: [] }],
    });
    at("#/agents");
    render(<App />);
    expect(await screen.findByText("No agents yet")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Create agent" }));
    fireEvent.click(screen.getByRole("button", { name: /Describe/ }));
    await waitFor(() => expect(window.location.hash).toBe(`#/agents/${ID}/build`));
    expect(sent.find((c) => c.route === "POST /api/v1/agents")?.body).toEqual({
      mode: "describe",
    });
  });

  it("imports a file after a preview, and explains a refused one", async () => {
    let refuse = true;
    const sent = serve({
      ...base,
      "POST /api/v1/agents/import": () =>
        refuse
          ? [400, { code: "SKILL_UNSAFE_ARCHIVE", message: "x" }]
          : [
              200,
              {
                token: "tok",
                title: "Imported",
                description: "",
                instructions: "Do it.",
                files: [],
                refs: [],
                sources: [{ label: "Old", source: "elsewhere", status: "unknown_source" }],
                issues: [],
              },
            ],
      "POST /api/v1/agents/import/tok/confirm": () => [201, { agent: agent({ status: "draft" }) }],
    });
    at("#/agents");
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Create agent" }));
    fireEvent.click(screen.getByRole("button", { name: /Import/ }));
    const input = await screen.findByLabelText("File to import");
    const file = new File(["# Hi"], "agent.zip", { type: "application/zip" });
    fireEvent.change(input, { target: { files: [file] } });
    expect((await screen.findByRole("alert")).textContent).toMatch(/nested archives/);
    refuse = false;
    fireEvent.change(input, { target: { files: [file] } });
    expect(await screen.findByText("Unknown source, dropped on import")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm import" }));
    await waitFor(() => expect(window.location.hash).toBe(`#/agents/${ID}`));
    expect(sent.find((c) => c.route === "POST /api/v1/agents/import/tok/confirm")?.body).toEqual({
      title: "Imported",
      drop_labels: [],
    });
  });
});

describe("agent editor", () => {
  it("saves, and names walled or missing attachments only in plain words", async () => {
    let reply: [number, unknown] = [
      403,
      { code: "WALL_DENIED", message: "x", detail: { attachment: "Secret" } },
    ];
    const sent = serve({ ...base, [`POST /api/v1/agents/${ID}/versions`]: () => reply });
    at(`#/agents/${ID}`);
    render(<App />);
    const box = await screen.findByLabelText("Instructions");
    await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe("Review the NDA."));
    fireEvent.change(box, { target: { value: "Review the NDA against @Playbook." } });
    expect(screen.getByText(/1 name in the instructions has nothing attached/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const alert = await screen.findByText(/1 attachment unavailable to you/);
    expect(alert.textContent).not.toMatch(/Secret/);

    reply = [400, { code: "AGENT_EMPTY_INSTRUCTIONS", message: "x" }];
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Add instructions before saving.")).toBeTruthy();

    reply = [
      201,
      {
        version: version(DRAFT, 2, "Review the NDA against @Playbook."),
        warnings: [{ code: "UNRESOLVED_LABEL", label: "@Playbook" }],
      },
    ];
    fireEvent.click(screen.getByRole("button", { name: "Save as draft" }));
    expect(
      await screen.findByText(/Saved as a draft\. Nothing is attached for @Playbook/),
    ).toBeTruthy();
    expect(
      sent.filter((c) => c.route === `POST /api/v1/agents/${ID}/versions`).at(-1)?.body,
    ).toEqual({
      instructions: "Review the NDA against @Playbook.",
      attachments: [],
      sources: [],
      promote: false,
    });
  });

  it("shows a draft's changes as a redline, then accepts or discards it", async () => {
    const withDraft = agent({ draft_version_id: DRAFT });
    const sent = serve({
      ...base,
      [`GET /api/v1/agents/${ID}`]: () => [200, { agent: withDraft }],
      [`GET /api/v1/agents/${ID}/versions`]: () => [
        200,
        {
          versions: [
            version(DRAFT, 2, "Review the NDA and email a summary."),
            version(LIVE, 1, "Review the NDA."),
          ],
        },
      ],
      [`GET /api/v1/agents/${ID}/versions/${LIVE}/diff/${DRAFT}`]: () => [
        200,
        {
          instructions_diff: [
            { op: "equal", text: "Review the NDA" },
            { op: "insert", text: " and email a summary" },
            { op: "equal", text: "." },
          ],
          attachments: { added: [], removed: [] },
          sources: { added: [], removed: [] },
        },
      ],
      [`POST /api/v1/agents/${ID}/versions`]: () => [
        201,
        { version: version("v3", 3, "x"), warnings: [] },
      ],
      [`DELETE /api/v1/agents/${ID}/draft`]: () => [204, null],
    });
    at(`#/agents/${ID}/changes`);
    const { container } = render(<App />);
    await waitFor(() =>
      expect(container.querySelector("ins")?.textContent).toContain("email a summary"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Side by side" }));
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    await waitFor(() =>
      expect(
        sent.find((c) => c.route === `POST /api/v1/agents/${ID}/versions`)?.body,
      ).toMatchObject({
        instructions: "Review the NDA and email a summary.",
        promote: true,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
    await waitFor(() =>
      expect(sent.some((c) => c.route === `DELETE /api/v1/agents/${ID}/draft`)).toBe(true),
    );
  });

  it("only reads, or only runs, without edit access", async () => {
    serve({
      ...base,
      [`GET /api/v1/agents/${ID}`]: () => [
        200,
        { agent: agent({ owner_id: "o", my_access: "run" }) },
      ],
    });
    at(`#/agents/${ID}`);
    render(<App />);
    expect(await screen.findByText(/Ask its owner for View access/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Share" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });

  it("confirms before deleting", async () => {
    const sent = serve({ ...base, [`DELETE /api/v1/agents/${ID}`]: () => [204, null] });
    at(`#/agents/${ID}`);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    expect(sent.some((c) => c.route.startsWith("DELETE"))).toBe(false);
    fireEvent.click(await screen.findByRole("button", { name: "Delete agent" }));
    await waitFor(() => expect(window.location.hash).toBe("#/agents"));
  });

  it("hears from the test tab that the draft changed", async () => {
    serve(base);
    at(`#/agents/${ID}`);
    render(<App />);
    await screen.findByLabelText("Instructions");
    new Channel("x").postMessage({ agentId: ID, draftVersionId: DRAFT });
    fireEvent.click(await screen.findByRole("button", { name: "View changes" }));
    expect(window.location.hash).toBe(`#/agents/${ID}/changes`);
  });
});

describe("running an agent", () => {
  it("starts a run with inputs, approves its plan and answers its question", async () => {
    const sent = serve({
      ...base,
      [`POST /api/v1/agents/${ID}/run`]: () => [202, { run_id: RUN, thread_id: THREAD }],
      [`POST /api/v1/runs/${RUN}/signal`]: () => [202, null],
    });
    at(`#/agents/${ID}`);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Run agent" }));
    fireEvent.change(await screen.findByLabelText("Inputs"), { target: { value: "The Acme NDA" } });
    fireEvent.click(screen.getByRole("button", { name: "Start run" }));
    await waitFor(() => expect(window.location.hash).toBe(`#/agents/${ID}/runs/${RUN}`));
    expect(sent.find((c) => c.route === `POST /api/v1/agents/${ID}/run`)?.body).toEqual({
      inputs: "The Acme NDA",
    });

    await waitFor(() => stream());
    stream().emit("plan", 1, {
      plan: {
        steps: [{ id: "s", title: "Read the NDA", sources: [], estimate: { docs: 1, pages: 4 } }],
        estimated_cost_usd: { low: 0.01, high: 0.02 },
        editable: true,
      },
    });
    stream().emit("status", 2, { status: "awaiting_approval" });
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await waitFor(() =>
      expect(sent.find((c) => c.route === `POST /api/v1/runs/${RUN}/signal`)?.body).toEqual({
        name: "approve_plan",
      }),
    );

    await waitFor(() => stream());
    stream().emit("step", 3, {
      step_id: "st",
      kind: "ask_user",
      status: "awaiting_user",
      title: "Ask a question",
      model: "anthropic/claude-haiku-5-5",
      cost_usd: 0.001,
    });
    stream().emit("question", 4, {
      step_id: "st",
      question: {
        text: "Which side are we on?",
        options: [{ id: "disc", label: "Disclosing" }],
        allow_text: true,
        allow_skip: true,
      },
    });
    stream().emit("status", 5, { status: "awaiting_input" });
    expect(screen.getByText("anthropic/claude-haiku-5-5")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: /Disclosing/ }));
    await waitFor(() =>
      expect(
        sent.filter((c) => c.route === `POST /api/v1/runs/${RUN}/signal`).at(-1)?.body,
      ).toEqual({
        name: "answer_question",
        step_id: "st",
        answer: { option_id: "disc" },
      }),
    );
    expect(screen.queryByText("Which side are we on?")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(await screen.findByRole("button", { name: "Resume" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel run" }));
    await waitFor(() =>
      expect(
        sent.filter((c) => c.route === `POST /api/v1/runs/${RUN}/signal`).at(-1)?.body,
      ).toEqual({
        name: "cancel",
        reason: "cancelled",
      }),
    );
    expect(screen.getByRole("link", { name: /Open thread/ }).getAttribute("href")).toBe(
      `#/t/${THREAD}`,
    );
  });
});

describe("builder and test mode", () => {
  it("builds by conversation and reloads the draft it writes", async () => {
    let versionLoads = 0;
    const sent = serve({
      ...base,
      [`GET /api/v1/agents/${ID}`]: () => [
        200,
        { agent: agent({ status: "draft", live_version_id: null, draft_version_id: DRAFT }) },
      ],
      [`GET /api/v1/agents/${ID}/versions`]: () => {
        versionLoads += 1;
        return [
          200,
          { versions: versionLoads > 1 ? [version(DRAFT, 1, "Drafted by the builder.")] : [] },
        ];
      },
      [`GET /api/v1/runs?filter%5Bkind%5D=agent_builder&filter%5Bsubject_id%5D=${ID}&limit=1`]:
        () => [200, { runs: [] }],
      [`POST /api/v1/agents/${ID}/builder`]: () => [202, { run_id: RUN, thread_id: THREAD }],
      [`POST /api/v1/runs/${RUN}/signal`]: () => [202, null],
    });
    at(`#/agents/${ID}/build`);
    render(<App />);
    fireEvent.change(await screen.findByLabelText("What should the agent do?"), {
      target: { value: "Review NDAs" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => stream());
    expect(sent.find((c) => c.route === `POST /api/v1/agents/${ID}/builder`)?.body).toEqual({
      message: "Review NDAs",
    });
    stream().emit("question", 1, {
      step_id: "q1",
      question: { text: "Which playbook?", options: [], allow_text: true, allow_skip: true },
    });
    stream().emit("status", 2, { status: "awaiting_input" });
    fireEvent.click(await screen.findByRole("button", { name: "Skip remaining" }));
    await waitFor(() =>
      expect(sent.find((c) => c.route === `POST /api/v1/runs/${RUN}/signal`)?.body).toEqual({
        name: "answer_question",
        step_id: "q1",
        answer: { skip: true },
      }),
    );
    stream().emit("draft_updated", 3, { agent_id: ID, draft_version_id: DRAFT });
    await waitFor(() =>
      expect((screen.getByLabelText("Instructions") as HTMLTextAreaElement).value).toBe(
        "Drafted by the builder.",
      ),
    );
  });

  it("requests changes from the test tab and tells the editor", async () => {
    const sent = serve({
      ...base,
      [`POST /api/v1/agents/${ID}/test`]: () => [202, { run_id: "r-test", thread_id: THREAD }],
      [`POST /api/v1/agents/${ID}/test/request-changes`]: () => [202, { run_id: RUN }],
      "GET /api/v1/runs/r-test": () => [200, { run: { ...runRow(), id: "r-test" } }],
    });
    at(`#/agents/${ID}/test?version=${LIVE}`);
    render(<App />);
    fireEvent.change(await screen.findByLabelText("Message"), {
      target: { value: "Try this NDA" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Run test" }));
    await waitFor(() =>
      expect(sent.find((c) => c.route === `POST /api/v1/agents/${ID}/test`)?.body).toEqual({
        inputs: "Try this NDA",
        version_id: LIVE,
      }),
    );
    fireEvent.change(screen.getByLabelText("Request changes"), {
      target: { value: "Be shorter" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Request changes" }));
    await waitFor(() =>
      expect(
        sent.find((c) => c.route === `POST /api/v1/agents/${ID}/test/request-changes`)?.body,
      ).toEqual({ request: "Be shorter", thread_id: THREAD }),
    );
    await waitFor(() => stream());
    stream().emit("draft_updated", 1, { agent_id: ID, draft_version_id: DRAFT });
    expect(await screen.findByText(/The draft was updated/)).toBeTruthy();
    expect(Channel.sent).toEqual([{ agentId: ID, draftVersionId: DRAFT }]);
  });
});

describe("schedule and sharing", () => {
  it("schedules in the browser's zone and shows a paused schedule's reason", async () => {
    const sent = serve({
      ...base,
      [`PUT /api/v1/agents/${ID}/schedule`]: (body) => [
        200,
        {
          schedule: {
            ...(body as object),
            status: "paused",
            paused_reason: "Matter access changed",
            next_run_at: null,
          },
        },
      ],
    });
    at(`#/agents/${ID}`);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Schedule" }));
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect((screen.getByLabelText("Time zone") as HTMLSelectElement).value).toBe(zone);
    fireEvent.click(screen.getByRole("button", { name: "Friday" }));
    fireEvent.click(
      within(screen.getByRole("form", { name: "Schedule" })).getByRole("button", {
        name: "Schedule",
      }),
    );
    await waitFor(() =>
      expect(sent.find((c) => c.route === `PUT /api/v1/agents/${ID}/schedule`)?.body).toMatchObject(
        {
          rule: "weekly",
          params: { weekdays: [1, 5] },
          time_local: "09:00",
          tz: zone,
          email: false,
        },
      ),
    );
    expect(await screen.findByText(/Paused: Matter access changed/)).toBeTruthy();
  });

  it("shares, says when it waits for approval, and explains a cooldown", async () => {
    let reply: [number, unknown] = [202, { outcome: "pending", id: "req1" }];
    const sent = serve({
      ...base,
      [`GET /api/v1/agents/${ID}/shares`]: () => [
        200,
        {
          grants: [
            {
              id: "g1",
              principal_type: "user",
              principal_id: "u2",
              level: "view",
              granted_by: ME,
              granted_at: "2026-11-02T00:00:00.000Z",
            },
          ],
          requests: [],
        },
      ],
      "GET /api/v1/admin/config/sharing": () => [
        403,
        { code: "FORBIDDEN", message: "Admins only." },
      ],
      [`POST /api/v1/agents/${ID}/shares`]: () => reply,
    });
    at(`#/agents/${ID}`);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Share" }));
    expect(await screen.findByText("Sam")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "Everyone in the workspace" }));
    fireEvent.click(
      within(screen.getByRole("form", { name: "Share" })).getByRole("button", { name: "Share" }),
    );
    expect(await screen.findByText(/Pending approval: an admin will review/)).toBeTruthy();
    expect(sent.find((c) => c.route === `POST /api/v1/agents/${ID}/shares`)?.body).toEqual({
      principal_type: "workspace",
      level: "run",
    });
    reply = [409, { code: "SHARE_REQUEST_COOLDOWN", message: "x" }];
    fireEvent.click(
      within(screen.getByRole("form", { name: "Share" })).getByRole("button", { name: "Share" }),
    );
    expect(await screen.findByText(/denied in the last 7 days/)).toBeTruthy();
  });

  it("lists activity with status, duration and cost", async () => {
    serve({
      ...base,
      [`GET /api/v1/agents/${ID}/activity`]: () => [
        200,
        {
          runs: [
            {
              id: RUN,
              kind: "agent",
              subject_id: ID,
              status: "done",
              started_by: ME,
              started_at: "2026-11-20T09:00:00.000Z",
              finished_at: "2026-11-20T09:01:05.000Z",
              cost_usd: 0.0123,
              test_mode: false,
              task_id: null,
              thread_id: THREAD,
              error_code: null,
            },
          ],
          next_run_at: null,
        },
      ],
    });
    at(`#/agents/${ID}/activity`);
    render(<App />);
    expect(await screen.findByText("1 m 5 s")).toBeTruthy();
    expect(screen.getByText("$0.0123")).toBeTruthy();
    expect(screen.getByText("Done")).toBeTruthy();
  });
});

describe("share approvals", () => {
  it("accepts and denies requests with a reason", async () => {
    const sent = serve({
      ...base,
      "GET /api/v1/admin/sharing/requests?filter[status]=pending": () => [
        200,
        {
          requests: [
            {
              id: "q1",
              resource_type: "agent",
              resource_id: ID,
              title: "NDA first pass",
              principal_type: "workspace",
              principal_id: "w",
              level: "run",
              approver: "agents_admin",
              status: "pending",
              requested_by: "u2",
              reason: null,
              created_at: "2026-11-20T09:00:00.000Z",
            },
          ],
        },
      ],
      "POST /api/v1/admin/sharing/requests/q1/accept": () => [204, null],
      "POST /api/v1/admin/sharing/requests/q1/deny": () => [204, null],
    });
    at("#/admin/sharing/requests");
    render(<App />);
    expect(await screen.findByText("Sam")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    await waitFor(() =>
      expect(sent.some((c) => c.route === "POST /api/v1/admin/sharing/requests/q1/accept")).toBe(
        true,
      ),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Deny" }));
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: "Not yet" } });
    fireEvent.click(screen.getByRole("button", { name: "Deny request" }));
    await waitFor(() =>
      expect(
        sent.find((c) => c.route === "POST /api/v1/admin/sharing/requests/q1/deny")?.body,
      ).toEqual({
        reason: "Not yet",
      }),
    );
  });

  it("saves the approval switches, and turns away non-admins", async () => {
    const sent = serve({
      ...base,
      "GET /api/v1/admin/config/sharing": () => [
        200,
        { require_approval: { individual: false, group: false, workspace: true } },
      ],
      "PUT /api/v1/admin/config/sharing": (body) => [200, body],
    });
    at("#/admin/sharing/approvals");
    render(<App />);
    fireEvent.click(await screen.findByRole("checkbox", { name: "Sharing with a person" }));
    await waitFor(() =>
      expect(sent.find((c) => c.route === "PUT /api/v1/admin/config/sharing")?.body).toEqual({
        require_approval: { individual: true, group: false, workspace: true },
      }),
    );
  });

  it("tells a non-admin the queue isn't theirs", async () => {
    serve({
      ...base,
      "GET /api/v1/admin/sharing/requests?filter[status]=pending": () => [
        403,
        { code: "FORBIDDEN", message: "Admins only." },
      ],
    });
    at("#/admin/sharing/requests");
    render(<App />);
    expect(await screen.findByText("Only agents admins can see this page.")).toBeTruthy();
  });
});
