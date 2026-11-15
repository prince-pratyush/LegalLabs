import type { Playbook, PlaybookSummary } from "@legallabs/contracts";
import { TooltipProvider } from "@legallabs/ui";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlaybookList } from "./PlaybookList.js";
import { PlaybookPage } from "./PlaybookPage.js";
import { parsePlaybookRoute, playbookHash } from "./route.js";

// The kit's table is virtualised, and jsdom lays nothing out, so it would draw no rows.
vi.mock("@legallabs/ui", async (original) => {
  const ui = await original<typeof import("@legallabs/ui")>();
  return {
    ...ui,
    PlaybookTable: (props: { rows: PlaybookSummary[]; loading?: boolean; onCreate: () => void }) =>
      props.rows.length === 0 && !props.loading ? (
        <button type="button" onClick={props.onCreate}>
          Create a playbook
        </button>
      ) : (
        <ul aria-label="Playbooks">
          {props.rows.map((p) => (
            <li key={p.id}>
              {p.name} <ui.PlaybookStatus status={p.status} /> {p.rule_count} rules, version{" "}
              {p.version_no}
            </li>
          ))}
        </ul>
      ),
  };
});

const ID = "0190a000-0000-7000-8000-00000000000a";
const RULE = "0190a000-0000-7000-8000-0000000000a1";

const playbook = (overrides: Partial<Playbook> = {}): Playbook => ({
  id: ID,
  workspace_id: "0190a000-0000-7000-8000-000000000001",
  owner_id: "0190a000-0000-7000-8000-000000000002",
  name: "SaaS MSA",
  contract_type: "MSA",
  guidance: null,
  status: "unpublished",
  version_id: "0190a000-0000-7000-8000-0000000000b2",
  version_no: 2,
  rules: [
    {
      id: RULE,
      ordinal: 0,
      title: "Liability cap",
      standard_position: "Twelve months' fees.",
      fallbacks: [],
      flag: false,
      actions: [],
      provenance: null,
    },
  ],
  access: "manage",
  created_at: "2026-11-01T00:00:00.000Z",
  updated_at: "2026-11-02T00:00:00.000Z",
  ...overrides,
});

const summary = (p: Playbook): PlaybookSummary => {
  const { rules, ...rest } = p;
  return { ...rest, rule_count: rules.length };
};

type Handler = (body: unknown, url: string) => [number, unknown];

function serve(routes: Record<string, Handler>) {
  const sent: { route: string; url: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const path = input.split("?")[0] ?? input;
      const route = `${init?.method ?? "GET"} ${path}`;
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
      sent.push({ route, url: input, body });
      const [status, json] = routes[route]?.(body, input) ?? [
        404,
        { code: "NOT_FOUND", message: "No." },
      ];
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

const versions = [
  {
    version_id: "v2",
    no: 2,
    created_by: "u",
    created_at: "2026-11-02T00:00:00.000Z",
    rule_count: 1,
  },
  {
    version_id: "v1",
    no: 1,
    created_by: "u",
    created_at: "2026-11-01T00:00:00.000Z",
    rule_count: 0,
  },
];

describe("playbook routes", () => {
  it("round-trip through the address", () => {
    for (const route of [
      { page: "list" } as const,
      { page: "playbook", playbookId: ID, version: null } as const,
      { page: "playbook", playbookId: ID, version: 3 } as const,
    ]) {
      expect(parsePlaybookRoute(playbookHash(route))).toEqual(route);
    }
    expect(parsePlaybookRoute("#/vaults")).toBeNull();
  });
});

describe("PlaybookList", () => {
  it("lists playbooks with their status, rule count and version, filtered by status", async () => {
    const sent = serve({
      "GET /api/v1/playbooks": () => [200, { items: [summary(playbook())] }],
    });
    render(<PlaybookList onChanged={vi.fn()} />);
    const row = await screen.findByText(/SaaS MSA/);
    expect(row.textContent).toMatch(/SaaS MSA\s*Unpublished\s*1 rules, version 2/);
    fireEvent.click(screen.getByRole("button", { name: "Published" }));
    await waitFor(() =>
      expect(sent.at(-1)?.url).toBe("/api/v1/playbooks?filter%5Bstatus%5D=published"),
    );
  });

  it("creates a playbook from a template and opens it", async () => {
    const sent = serve({
      "GET /api/v1/playbooks": () => [200, { items: [] }],
      "GET /api/v1/documents": () => [200, { documents: [] }],
      "POST /api/v1/playbooks": () => [201, { playbook: playbook({ id: ID }) }],
    });
    render(
      <TooltipProvider>
        <PlaybookList onChanged={vi.fn()} />
      </TooltipProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Create a playbook" }));
    fireEvent.click(await screen.findByLabelText(/Start from a template/));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Our NDA" } });
    fireEvent.change(screen.getByLabelText("Contract type"), { target: { value: "NDA" } });
    fireEvent.click(screen.getByRole("button", { name: "Create playbook" }));
    await waitFor(() => expect(window.location.hash).toBe(`#/playbooks/${ID}`));
    expect(sent.find((s) => s.route === "POST /api/v1/playbooks")?.body).toEqual({
      name: "Our NDA",
      contract_type: "NDA",
      source: { kind: "starter", template: "nda" },
    });
  });
});

describe("PlaybookPage", () => {
  it("saves edits as a new version, keeping rule ids", async () => {
    const sent = serve({
      [`GET /api/v1/playbooks/${ID}`]: () => [200, { playbook: playbook() }],
      [`GET /api/v1/playbooks/${ID}/versions`]: () => [200, { items: versions }],
      [`PATCH /api/v1/playbooks/${ID}`]: () => [
        200,
        { playbook: playbook({ name: "SaaS MSA v3", version_no: 3 }) },
      ],
    });
    render(
      <TooltipProvider>
        <PlaybookPage playbookId={ID} version={null} onChanged={vi.fn()} />
      </TooltipProvider>,
    );
    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "SaaS MSA v3" } });
    fireEvent.click(screen.getByRole("button", { name: "Save version" }));
    await waitFor(() => expect(screen.getByText("Version 3")).toBeTruthy());
    const patch = sent.find((s) => s.route.startsWith("PATCH"))?.body as {
      name: string;
      rules: { id: string }[];
    };
    expect(patch.name).toBe("SaaS MSA v3");
    expect(patch.rules[0]?.id).toBe(RULE);
  });

  it("publishes for an approver and shows the API's refusal", async () => {
    serve({
      [`GET /api/v1/playbooks/${ID}`]: () => [200, { playbook: playbook() }],
      [`GET /api/v1/playbooks/${ID}/versions`]: () => [200, { items: versions }],
      [`POST /api/v1/playbooks/${ID}/publish`]: () => [
        403,
        { code: "FORBIDDEN", message: "You don't have access to do that with this playbook." },
      ],
    });
    render(
      <TooltipProvider>
        <PlaybookPage playbookId={ID} version={null} onChanged={vi.fn()} />
      </TooltipProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Publish" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/don't have access/);
  });

  it("shows a past version read-only", async () => {
    serve({
      [`GET /api/v1/playbooks/${ID}`]: () => [200, { playbook: playbook() }],
      [`GET /api/v1/playbooks/${ID}/versions`]: () => [200, { items: versions }],
      [`GET /api/v1/playbooks/${ID}/versions/1`]: () => [
        200,
        { playbook: playbook({ version_no: 1, rules: [], name: "First draft" }) },
      ],
    });
    render(
      <TooltipProvider>
        <PlaybookPage playbookId={ID} version={1} onChanged={vi.fn()} />
      </TooltipProvider>,
    );
    expect(await screen.findByText("Version 1 of 2")).toBeTruthy();
    await waitFor(() =>
      expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("First draft"),
    );
    expect(screen.queryByRole("button", { name: "Save version" })).toBeNull();
  });
});
