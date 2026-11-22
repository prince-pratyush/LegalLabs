import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { serve } from "../testing.js";
import { AdminModelsApp } from "./AdminModelsApp.js";
import { adminModelsHash, parseAdminModelsRoute } from "./route.js";

const at = (tab: string) => {
  window.location.hash = `#/admin/${tab}`;
};
const show = () => render(<AdminModelsApp onLeave={() => {}} />);
const last = (sent: { route: string; body: unknown }[], route: string) =>
  sent.filter((s) => s.route === route).at(-1)?.body;

const ROLE = "0190a000-0000-7000-8000-0000000000a1";
const model = (over: object = {}) => ({
  provider: "anthropic",
  model: "claude-sonnet",
  enabled: true,
  enabled_for_roles: [ROLE],
  enabled_for_users: [],
  byok_secret_ref: "sec_abc",
  endpoint_url: null,
  region: "eu",
  zdr: true,
  capabilities: ["chat"],
  context_window: 200000,
  task_class_default: [],
  ...over,
});
const policy = { zdr_only: false, region_only: null, selector_disabled_roles: [] };

describe("admin models routes", () => {
  it("reads the tab from the address", () => {
    expect(parseAdminModelsRoute("#/admin/models")).toEqual({ tab: "models" });
    expect(parseAdminModelsRoute("#/admin/connectors?x=1")).toEqual({ tab: "connectors" });
    expect(parseAdminModelsRoute("#/admin/users")).toBeNull();
    expect(parseAdminModelsRoute("#/admin")).toBeNull();
    expect(parseAdminModelsRoute("#/settings")).toBeNull();
    expect(adminModelsHash("connectors")).toBe("#/admin/connectors");
  });
});

describe("models tab", () => {
  const routes = (extra = {}) => ({
    "GET /api/v1/admin/models": () =>
      [
        200,
        { items: [model(), model({ model: "b", byok_secret_ref: null, zdr: false })], policy },
      ] as [number, unknown],
    "GET /api/v1/admin/roles": () =>
      [200, { items: [{ id: ROLE, name: "Associate" }] }] as [number, unknown],
    ...extra,
  });

  it("lists models and never renders a key", async () => {
    at("models");
    serve(routes());
    const { container } = show();
    await screen.findByText("anthropic/claude-sonnet");
    expect(screen.getByText("Key saved")).toBeTruthy();
    expect(screen.getByText("No key")).toBeTruthy();
    expect(screen.getByText("ZDR")).toBeTruthy();
    expect(screen.getAllByText("Associate").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Edit anthropic/claude-sonnet" }));
    const key = (await screen.findByLabelText("API key")) as HTMLInputElement;
    expect(key.type).toBe("password");
    expect(key.value).toBe("");
    expect(container.innerHTML).not.toContain("sec_abc");
  });

  it("toggles enabled with a PATCH and clears the key after saving", async () => {
    at("models");
    const sent = serve(
      routes({
        "PATCH /api/v1/admin/models/anthropic/claude-sonnet": () => [
          200,
          model({ enabled: false }),
        ],
        "PUT /api/v1/admin/models/anthropic/claude-sonnet/key": () => [200, model()],
      }),
    );
    show();
    const toggle = await screen.findByRole("checkbox", {
      name: "Enabled: anthropic/claude-sonnet",
    });
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(last(sent, "PATCH /api/v1/admin/models/anthropic/claude-sonnet")).toEqual({
        enabled: false,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit anthropic/claude-sonnet" }));
    const key = (await screen.findByLabelText("API key")) as HTMLInputElement;
    fireEvent.change(key, { target: { value: "sk-secret-value" } });
    fireEvent.click(screen.getByRole("button", { name: "Save key" }));
    await waitFor(() =>
      expect(last(sent, "PUT /api/v1/admin/models/anthropic/claude-sonnet/key")).toEqual({
        key: "sk-secret-value",
      }),
    );
    await waitFor(() =>
      expect((screen.getByLabelText("API key") as HTMLInputElement).value).toBe(""),
    );
  });

  it("saves the workspace policy", async () => {
    at("models");
    const next = { zdr_only: true, region_only: "eu", selector_disabled_roles: [ROLE] };
    const sent = serve(routes({ "PUT /api/v1/admin/model-policy": () => [200, next] }));
    show();
    fireEvent.click(
      await screen.findByRole("checkbox", { name: "Zero-data-retention models only" }),
    );
    fireEvent.change(screen.getByLabelText("Only models in region"), { target: { value: "eu" } });
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Model selector disabled for: Associate" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save policy" }));
    await waitFor(() => expect(last(sent, "PUT /api/v1/admin/model-policy")).toEqual(next));
  });
});

const TOOL = {
  name: "search",
  description: "Search things",
  input_schema: {},
  annotations: {},
  policy: "block",
  user_policy: null,
};
const connector = (over: object = {}) => ({
  id: "0190a000-0000-7000-8000-0000000000c1",
  name: "Acme MCP",
  url: "https://mcp.acme.example",
  auth_kind: "none",
  trust_tier: "custom",
  badge: "Custom — not reviewed",
  status: "pending_approval",
  manifest_hash: null,
  disabled_reason: null,
  tools: [TOOL],
  created_at: "2026-11-10T00:00:00.000Z",
  ...over,
});
const CID = connector().id;

describe("connectors tab", () => {
  const list = (items: object[], extra = {}) => ({
    "GET /api/v1/admin/connectors": () => [200, { items }] as [number, unknown],
    ...extra,
  });

  it("lists connectors with the custom badge and a blocked default", async () => {
    at("connectors");
    serve(list([connector()]));
    show();
    await screen.findByText("Acme MCP");
    expect(screen.getByText("Custom — not reviewed")).toBeTruthy();
    expect(screen.getByText("Pending approval")).toBeTruthy();
    expect((screen.getByLabelText("Policy for search") as HTMLSelectElement).value).toBe("block");
    expect(
      (screen.getByRole("button", { name: "Approve Acme MCP" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("disables Approve until a tool is discovered", async () => {
    at("connectors");
    serve(list([connector({ tools: [] })]));
    show();
    await screen.findByText("Acme MCP");
    expect(
      (screen.getByRole("button", { name: "Approve Acme MCP" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("changes a tool policy with a PUT", async () => {
    at("connectors");
    const route = `PUT /api/v1/admin/connectors/${CID}/tools/search/policy`;
    const sent = serve(
      list([connector()], {
        [route]: () => [200, connector({ tools: [{ ...TOOL, policy: "allow" }] })],
      }),
    );
    show();
    fireEvent.change(await screen.findByLabelText("Policy for search"), {
      target: { value: "allow" },
    });
    await waitFor(() => expect(last(sent, route)).toEqual({ policy: "allow" }));
    await waitFor(() =>
      expect((screen.getByLabelText("Policy for search") as HTMLSelectElement).value).toBe("allow"),
    );
  });

  it("shows the drift banner with the diff after discovery", async () => {
    at("connectors");
    const drifted = connector({
      status: "disabled",
      disabled_reason: "CONNECTOR_MANIFEST_CHANGED",
    });
    serve(
      list([drifted], {
        [`POST /api/v1/admin/connectors/${CID}/discover`]: () => [
          200,
          {
            connector: drifted,
            diff: { added: ["export"], removed: ["old"], changed: ["search"] },
          },
        ],
      }),
    );
    show();
    const banner = await screen.findByRole("alert");
    expect(within(banner).getByText(/changed since you approved/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Discover tools for Acme MCP" }));
    await screen.findByText("Added: export");
    expect(screen.getByText("Removed: old")).toBeTruthy();
    expect(screen.getByText("Changed: search")).toBeTruthy();
  });

  it("tells the person when they may only tighten a tool", async () => {
    at("connectors");
    serve(
      list([connector()], {
        [`PUT /api/v1/connectors/${CID}/tools/search/my-policy`]: () => [
          422,
          { code: "POLICY_TIGHTEN_ONLY", message: "You can only make a tool stricter." },
        ],
      }),
    );
    show();
    fireEvent.change(await screen.findByLabelText("My setting for search"), {
      target: { value: "ask_user" },
    });
    await screen.findByText("You can only make a tool stricter.");
  });

  it("registers a custom server over https only", async () => {
    at("connectors");
    const sent = serve(list([], { "POST /api/v1/admin/connectors": () => [200, connector()] }));
    show();
    fireEvent.change(await screen.findByLabelText("Server name"), {
      target: { value: "Acme MCP" },
    });
    fireEvent.change(screen.getByLabelText("Server URL"), {
      target: { value: "http://x.example" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Register server" }));
    await screen.findByText("The URL must start with https://.");
    fireEvent.change(screen.getByLabelText("Server URL"), {
      target: { value: "https://mcp.acme.example" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Register server" }));
    await waitFor(() =>
      expect(last(sent, "POST /api/v1/admin/connectors")).toEqual({
        name: "Acme MCP",
        url: "https://mcp.acme.example",
        auth: { kind: "none" },
      }),
    );
    await screen.findByText("Custom — not reviewed");
  });
});
