import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { serve } from "../testing.js";
import { CommandCenterApp } from "./CommandCenterApp.js";
import { lastDays } from "./labels.js";
import { commandCenterHash, parseCommandCenterRoute } from "./route.js";

const { from, to } = lastDays(30);
const range = `from=${from}&to=${to}`;
const BASE = "/api/v1/admin/analytics";
const ok = (body: unknown) => () => [200, body] as [number, unknown];
const show = (tab: "overview" | "analytics" | "outcomes") => {
  window.location.hash = commandCenterHash(tab);
  render(<CommandCenterApp onLeave={() => {}} />);
};
const ready = { state: "ready", dataAsOf: "2026-11-26T06:00:00.000Z", range: { from, to } };
const overview = (over: object = {}) => ({
  ...ready,
  monthlyUsersReturningDaily: [{ month: "2026-11", days: 20, percent: 40 }],
  productUsageBySurface: {
    activeUsers: 2,
    surfaces: [
      { surface: "web", users: 2, share: 100 },
      { surface: "outlook", users: 0, share: 0 },
    ],
  },
  totalActiveUsers: { grouping: "day", series: [{ bucket: "2026-11-25", users: 2 }] },
  topPowerUsers: [],
  recommendedActions: [],
  ...over,
});

describe("command center routes", () => {
  it("reads the tab from the address", () => {
    expect(parseCommandCenterRoute("#/admin/command-center")).toEqual({ tab: "overview" });
    expect(parseCommandCenterRoute("#/admin/command-center/outcomes")).toEqual({
      tab: "outcomes",
    });
    expect(parseCommandCenterRoute("#/admin/command-center/nope")).toBeNull();
    expect(parseCommandCenterRoute("#/admin/models")).toBeNull();
  });
});

describe("overview", () => {
  const url = `GET ${BASE}/overview?${range}&grouping=day`;

  it("shows no numbers before the first refresh, and can ask for one", async () => {
    const sent = serve({
      [url]: ok(
        overview({
          state: "no_materialisation_yet",
          dataAsOf: null,
          message: "First refresh at 2026-11-26T12:00:00.000Z",
        }),
      ),
      [`POST ${BASE}/refresh`]: () => [
        429,
        { code: "REFRESH_TOO_SOON", message: "The data was refreshed less than an hour ago." },
      ],
    });
    show("overview");
    expect(await screen.findByText("No usage data yet")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Top power users" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Refresh now" }));
    expect((await screen.findByRole("alert")).textContent).toContain("less than an hour");
    expect(sent.some((s) => s.route === `POST ${BASE}/refresh`)).toBe(true);
  });

  it("says a surface nothing writes is not recorded, not zero", async () => {
    serve({ [url]: ok(overview()) });
    show("overview");
    const table = await screen.findByRole("table", { name: "Product usage by surface" });
    const outlook = within(table).getByText("Outlook add-in").closest("tr");
    expect(outlook?.textContent).toBe("Outlook add-inNot recorded");
    expect(
      screen.getByRole("link", { name: "Download Top power users as CSV" }).getAttribute("href"),
    ).toBe(`${BASE}/csv?chart=power_users&${range}&grouping=day`);
  });

  it("shows the server's words to someone without reporting access", async () => {
    serve({
      [url]: () => [403, { code: "FORBIDDEN", message: "You don't have access to reporting." }],
    });
    show("overview");
    expect((await screen.findByRole("alert")).textContent).toContain("access to reporting");
  });
});

describe("analytics", () => {
  const row = {
    user_id: "u1",
    name: "Ana",
    email: "ana@x.test",
    role: "Admin",
    active_days: 3,
    total_activity: 9,
    threads: 4,
    follow_ups: 5,
    agent_runs: 0,
    playbook_runs: 0,
    rt_columns: 0,
    word: 0,
    last_active: "2026-11-25",
  };
  const users = (sort: string) =>
    `GET ${BASE}/users?${range}&sort=${sort}&dir=desc&page=1&page_size=25`;

  it("sorts the users table on the server and starts an export", async () => {
    const report = ok({
      ...ready,
      queriesOverTime: { granularity: "day", series: [] },
      topPracticeAreas: [],
      topJobTitles: [],
    });
    const page = ok({ rows: [row], total: 1, page: 1, page_size: 25 });
    const sent = serve({
      [`GET ${BASE}/report?${range}&granularity=day`]: report,
      [`GET ${BASE}/report?${range}`]: report,
      "GET /api/v1/admin/roles": ok({ items: [] }),
      [users("active_days")]: page,
      [users("threads")]: page,
      [`GET ${BASE}/exports`]: ok({ exports: [] }),
      [`POST ${BASE}/exports`]: () => [201, { export: {} }],
    });
    show("analytics");
    await screen.findByRole("table", { name: "Users by activity" });
    expect((await screen.findAllByText("No queries recorded in this range.")).length).toBe(3);
    fireEvent.click(screen.getByRole("button", { name: "Threads" }));
    await screen.findByRole("button", { name: "Threads ↓" });
    expect(sent.some((s) => s.route === users("threads"))).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /^Export events/ }));
    await screen.findByText("No exports yet.");
    expect(sent.find((s) => s.route === `POST ${BASE}/exports`)?.body).toEqual({
      from,
      to,
      include_former: true,
    });
  });
});

describe("outcomes", () => {
  it("shows what is missing in words and saves a baseline", async () => {
    const baseline = {
      workflow_type: "draft_exported",
      hours_per_completion: 1.5,
      note: "",
      is_default: true,
    };
    const sent = serve({
      [`GET ${BASE}/outcomes?${range}`]: ok({
        ...ready,
        methodology: "Captured from completions, not surveys; baselines are yours.",
        hoursSaved: 0,
        contractsReviewed: 0,
        citations: { verified: 0, flagged: 0, rate: null },
        workflows: [],
      }),
      [`GET ${BASE}/baselines`]: ok({ baselines: [baseline] }),
      [`PUT ${BASE}/baselines/draft_exported`]: () => [
        403,
        { code: "FORBIDDEN", message: "You don't have access to reporting." },
      ],
    });
    show("outcomes");
    expect(await screen.findByText("No completions")).toBeTruthy();
    expect(screen.getByText("None checked")).toBeTruthy();
    expect(screen.getByText("Not recorded")).toBeTruthy();
    const hours = await screen.findByRole("spinbutton", { name: "Hours for Draft exported" });
    fireEvent.change(hours, { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Draft exported" }));
    expect((await screen.findByRole("alert")).textContent).toContain("access");
    expect(sent.find((s) => s.route === `PUT ${BASE}/baselines/draft_exported`)?.body).toEqual({
      hours: 2,
      note: "",
    });
  });
});
