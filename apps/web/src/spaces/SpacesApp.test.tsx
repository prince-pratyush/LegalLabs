import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GuestsTab, partyLevels } from "./GuestsTab.js";
import { ResourcesTab } from "./ResourcesTab.js";
import { parseSpaceRoute, spacesHash } from "./route.js";
import { SpacesApp } from "./SpacesApp.js";

const SPACE = {
  id: "0190a000-0000-7000-8000-000000000010",
  name: "Acme share purchase",
  kind: "internal" as "internal" | "external",
  matter: { id: "m1", display: "00123-0001 Acme Corp" },
  context: { version: 2, parties: [{ name: "Acme Holdings", role: "buyer" }], key_dates: [] },
  customization: {},
  my_role: "admin",
  counts: { members: 2, resources: 0, open_tasks: 2 },
  created_at: "2026-11-10T00:00:00.000Z",
};

const PHASES = [
  { id: "p1", ordinal: 1, name: "Diligence", locked: false, gate_pending: 1 },
  { id: "p2", ordinal: 2, name: "Signing", locked: true, gate_pending: 0 },
];

const task = (over: Record<string, unknown>) => ({
  id: "t",
  space_id: SPACE.id,
  phase_id: null,
  name: "Task",
  description_md: "",
  assignee: null,
  due_at: null,
  status: "todo",
  awaiting_approval: false,
  locked: false,
  gate: false,
  run: null,
  comments_count: 0,
  ...over,
});

function serve(options: { tasks?: unknown[]; role?: "admin" | "collaborator" } = {}) {
  const calls: { method: string; url: string }[] = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ method, url });
      if (url.startsWith("/api/v1/spaces?")) return json({ spaces: [SPACE] });
      if (url === "/api/v1/spaces/directory") {
        return json({
          spaces: [
            { id: SPACE.id, name: SPACE.name, matter_id: "m1", locked: false },
            { id: "other", name: "Beta litigation", matter_id: "m2", locked: true },
          ],
        });
      }
      if (url === `/api/v1/spaces/${SPACE.id}`) {
        return json({ space: { ...SPACE, my_role: options.role ?? "admin" } });
      }
      if (url.endsWith("/phases")) return json({ phases: PHASES });
      if (url.endsWith("/tasks")) return json({ tasks: options.tasks ?? [] });
      if (url.endsWith("/members")) {
        return json({
          members: [
            {
              id: "a",
              principal_type: "user",
              principal_id: "u1",
              label: "Ana Silva",
              role: "admin",
            },
          ],
        });
      }
      if (url.endsWith("/approve") || url.includes("/access-requests")) return json({});
      return new Response(null, { status: 404 });
    }),
  );
  return calls;
}

beforeEach(() => {
  window.location.hash = "";
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("space routes", () => {
  it("reads the list, a Space and its tab", () => {
    expect(parseSpaceRoute("#/spaces")).toEqual({ page: "list" });
    expect(parseSpaceRoute("#/spaces/abc/members")).toEqual({
      page: "space",
      spaceId: "abc",
      tab: "members",
    });
    expect(parseSpaceRoute("#/spaces/abc")).toMatchObject({ tab: "tasks" });
    expect(parseSpaceRoute("#/vaults")).toBeNull();
    expect(spacesHash("a b", "activity")).toBe("#/spaces/a%20b/activity");
  });
});

describe("SpacesApp", () => {
  it("lists my Spaces and offers to ask to join a locked one", { timeout: 20_000 }, async () => {
    const calls = serve();
    window.location.hash = "#/spaces";
    render(<SpacesApp onLeave={() => {}} />);
    const list = await screen.findByRole("list", { name: "Your Spaces" });
    expect(within(list).getByText("Acme share purchase")).toBeTruthy();
    expect(within(list).getByText(/00123-0001 Acme Corp/)).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Request access" }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: "POST",
        url: "/api/v1/spaces/other/access-requests",
      }),
    );
  });

  it("shows phases with a locked one, and lets an admin approve a gate", {
    timeout: 20_000,
  }, async () => {
    const calls = serve({
      tasks: [
        task({
          id: "g",
          name: "Partner sign-off",
          phase_id: "p1",
          gate: true,
          status: "in_progress",
          awaiting_approval: true,
        }),
        task({ id: "n", name: "Prepare copies", phase_id: "p2" }),
      ],
    });
    window.location.hash = `#/spaces/${SPACE.id}/tasks`;
    render(<SpacesApp onLeave={() => {}} />);
    const diligence = await screen.findByRole("region", { name: "Phase: Diligence" });
    expect(within(diligence).getByText("Awaiting approval")).toBeTruthy();
    const signing = await screen.findByRole("region", { name: "Phase: Signing" });
    expect(within(signing).getByText(/Locked until the gate is approved/)).toBeTruthy();
    fireEvent.click(within(diligence).getByRole("button", { name: "Approve" }));
    await waitFor(() =>
      expect(calls).toContainEqual({ method: "POST", url: "/api/v1/tasks/g/approve" }),
    );
  });

  it("keeps gate controls from collaborators", { timeout: 20_000 }, async () => {
    serve({
      role: "collaborator",
      tasks: [
        task({
          id: "g",
          name: "Sign-off",
          phase_id: "p1",
          gate: true,
          status: "in_progress",
          awaiting_approval: true,
        }),
      ],
    });
    window.location.hash = `#/spaces/${SPACE.id}/tasks`;
    render(<SpacesApp onLeave={() => {}} />);
    await screen.findByText("Sign-off");
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByLabelText("Review gate")).toBeNull();
  });

  it("says so when a Space isn't available", { timeout: 20_000 }, async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ code: "NOT_FOUND" }), { status: 404 })),
    );
    window.location.hash = `#/spaces/${SPACE.id}/tasks`;
    render(<SpacesApp onLeave={() => {}} />);
    expect(await screen.findByText("That Space isn't available")).toBeTruthy();
  });
});

describe("guest organisation", () => {
  const party = (status: string) => ({
    id: "pa",
    name: "Other LLP",
    domain: "other.test",
    connection_admin_emails: [],
    connection: { status, approvals: [] },
  });
  function guestServer(status: string) {
    const calls: { method: string; url: string; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({
          method: init?.method ?? "GET",
          url,
          body: init?.body ? JSON.parse(init.body as string) : null,
        });
        const answer = url.endsWith("/parties")
          ? { parties: [party(status)] }
          : url.endsWith("/guests")
            ? init?.method === "POST"
              ? { invite: { email: "a@other.test" }, accept_url: "/guest/accept#token=t" }
              : { guests: [] }
            : url.endsWith("/resources")
              ? {
                  resources: [
                    { id: "r1", resource_type: "agent", name: "NDA pass", per_party: {} },
                  ],
                }
              : {};
        return new Response(JSON.stringify(answer));
      }),
    );
    return calls;
  }
  const space = { ...SPACE, kind: "external" as const, my_role: "admin" as const };

  it("offers an agent to a guest party as Run or nothing", async () => {
    expect(partyLevels("agent")).toEqual(["none", "run"]);
    const calls = guestServer("resolved");
    render(<GuestsTab space={space} />);
    fireEvent.change(await screen.findByLabelText("Other LLP access to NDA pass"), {
      target: { value: "run" },
    });
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ per_party: { pa: "run" } }),
    );
  });

  it("shows the invitation link once an invite is made", async () => {
    guestServer("resolved");
    render(<GuestsTab space={space} />);
    fireEvent.change(await screen.findByLabelText("Guest email"), {
      target: { value: "a@other.test" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Invite" }));
    const link = (await screen.findByLabelText("Invitation link")) as HTMLInputElement;
    expect(link.value).toBe(`${window.location.origin}/guest/accept#token=t`);
  });

  it("asks only for the party when the viewer is not a Space admin", async () => {
    const calls = guestServer("action_required");
    render(<GuestsTab space={{ ...space, my_role: "collaborator" }} />);
    await screen.findByText("Other LLP");
    expect(calls).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Remove organisation" })).toBeNull();
  });
});

describe("agents in a Space", () => {
  function agentServer() {
    const calls: { method: string; url: string; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        calls.push({ method, url, body: init?.body ? JSON.parse(init.body as string) : null });
        if (url.startsWith("/api/v1/agents")) {
          return new Response(
            JSON.stringify({
              agents: [
                { id: "a1", title: "NDA pass", my_access: "full" },
                { id: "a2", title: "Borrowed", my_access: "run" },
              ],
            }),
          );
        }
        if (url.endsWith("/resources") && method === "POST") {
          return new Response(JSON.stringify({ request: { id: "q1" } }), { status: 202 });
        }
        if (url.endsWith("/share-requests/q1")) return new Response(null, { status: 204 });
        const answer = url.endsWith("/requests")
          ? {
              access: [],
              shares: [
                {
                  id: "q1",
                  name: "NDA pass",
                  access: "run",
                  per_party: {},
                  requester_name: "Ben",
                },
              ],
            }
          : url.endsWith("/parties")
            ? { parties: [] }
            : { resources: [] };
        return new Response(JSON.stringify(answer));
      }),
    );
    return calls;
  }

  it("shares only an agent held in full, and says when it waits for approval", async () => {
    const calls = agentServer();
    render(<ResourcesTab space={{ ...SPACE, kind: "external", my_role: "collaborator" }} />);
    await screen.findByRole("option", { name: "NDA pass" });
    expect(screen.queryByRole("option", { name: "Borrowed" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Agent"), { target: { value: "a1" } });
    fireEvent.click(screen.getByRole("button", { name: "Share agent" }));
    expect(await screen.findByText(/shared once one accepts/)).toBeTruthy();
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({
      resource_type: "agent",
      resource_id: "a1",
      access: "run",
    });
    expect(calls.some((c) => c.url.endsWith("/requests"))).toBe(false);
  });

  it("lets an admin decline a waiting share with a reason", async () => {
    const calls = agentServer();
    render(<ResourcesTab space={{ ...SPACE, kind: "external", my_role: "admin" }} />);
    fireEvent.click(await screen.findByRole("button", { name: "Decline sharing NDA pass" }));
    fireEvent.change(screen.getByLabelText("Reason for declining"), {
      target: { value: "Not yet" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send decline" }));
    await waitFor(() =>
      expect(calls.find((c) => c.url.endsWith("/share-requests/q1"))?.body).toEqual({
        decision: "deny",
        reason: "Not yet",
      }),
    );
  });
});
