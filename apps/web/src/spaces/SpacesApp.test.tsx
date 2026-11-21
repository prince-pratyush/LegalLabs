import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseSpaceRoute, spacesHash } from "./route.js";
import { SpacesApp } from "./SpacesApp.js";

const SPACE = {
  id: "0190a000-0000-7000-8000-000000000010",
  name: "Acme share purchase",
  kind: "internal",
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
