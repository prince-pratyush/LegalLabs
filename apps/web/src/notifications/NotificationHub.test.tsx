import type { Notification } from "@legallabs/contracts";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeSource, type Handler, serve } from "../testing.js";
import { NotificationBell, openLink } from "./NotificationHub.js";

const ID = (n: number) => `0190a000-0000-7000-8000-0000000001${String(n).padStart(2, "0")}`;

const item = (n: number, over: Partial<Notification> = {}): Notification => ({
  id: ID(n),
  kind: "thread.shared",
  category: "threads",
  object_type: "thread",
  object_id: ID(n + 50),
  title: `Item ${n}`,
  action_required: false,
  url: `#/t/${ID(n + 50)}`,
  created_at: "2026-11-10T00:00:00.000Z",
  count: 1,
  available: true,
  ...over,
});

const PLAN = item(1, {
  kind: "thread.run.awaiting_approval",
  title: "Approve the plan",
  action_required: true,
  actions: [{ id: "approve_plan", label: "Approve plan", style: "primary" }],
  read_at: "2026-11-10T01:00:00.000Z",
});

const feed = (items: Notification[], unread = 2, action = 1) => ({
  items,
  unread_count: unread,
  action_required_count: action,
  next_cursor: null,
});

const ALL = "GET /api/v1/notifications?tab=all&state=unread_read";
const ACTION = "GET /api/v1/notifications?tab=action_required&state=unread_read";
const COUNT = "GET /api/v1/notifications/unread-count";

function setup(extra: Record<string, Handler> = {}, items = [PLAN, item(2), item(3)]) {
  return serve({
    [COUNT]: () => [200, { unread: 2, action_required: 1 }],
    [ALL]: () => [200, feed(items)],
    [ACTION]: () => [200, feed([PLAN])],
    ...extra,
  });
}

const openHub = async () => {
  fireEvent.click(await screen.findByRole("button", { name: /^Notifications/ }));
  return screen.findByRole("list", { name: "Notifications" });
};

afterEach(() => vi.useRealTimers());

describe("the bell", () => {
  it("shows a dot only while something is unread", async () => {
    setup();
    render(<NotificationBell />);
    expect(await screen.findByRole("button", { name: "Notifications, 2 unread" })).toBeTruthy();
    expect(screen.getByTestId("unread-dot")).toBeTruthy();
  });

  it("has no dot when everything is read", async () => {
    setup({ [COUNT]: () => [200, { unread: 0, action_required: 0 }] });
    render(<NotificationBell />);
    await waitFor(() => expect(FakeSource.bell).toHaveLength(1));
    expect(screen.getByRole("button", { name: "Notifications" })).toBeTruthy();
    expect(screen.queryByTestId("unread-dot")).toBeNull();
  });

  it("follows the live stream, and re-reads the list when something arrives", async () => {
    let calls = 0;
    setup({
      [ALL]: () => {
        calls += 1;
        return [200, feed([PLAN])];
      },
    });
    render(<NotificationBell />);
    await openHub();
    await waitFor(() => expect(FakeSource.bell).toHaveLength(1));
    FakeSource.bell[0]?.emit("counts", 1, { unread: 5, action_required: 2 });
    expect(await screen.findByRole("button", { name: "Notifications, 5 unread" })).toBeTruthy();
    const before = calls;
    FakeSource.bell[0]?.emit("notification", 2, { notification: item(9) });
    await waitFor(() => expect(calls).toBeGreaterThan(before));
  });

  it("falls back to polling when the stream is dropped", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let unread = 1;
    setup({ [COUNT]: () => [200, { unread, action_required: 0 }] });
    render(<NotificationBell />);
    await screen.findByRole("button", { name: "Notifications, 1 unread" });
    unread = 4;
    FakeSource.bell[0]?.drop();
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(await screen.findByRole("button", { name: "Notifications, 4 unread" })).toBeTruthy();
  });
});

describe("the hub", () => {
  it("lists items with their unread state, count and actor", async () => {
    setup({}, [PLAN, item(2, { count: 3, actor: { id: ID(77), name: "Ben Ortiz" } })]);
    render(<NotificationBell />);
    const list = await openHub();
    expect(await within(list).findByText("Approve the plan")).toBeTruthy();
    expect(within(list).getByText("×3")).toBeTruthy();
    expect(within(list).getByText(/Ben Ortiz/)).toBeTruthy();
    expect(within(list).getByRole("button", { name: "Unread: Item 2" })).toBeTruthy();
  });

  it("switches tabs and filters by asking the server", async () => {
    const sent = setup({
      "GET /api/v1/notifications?tab=all&state=archived": () => [200, feed([])],
      "GET /api/v1/notifications?tab=all&state=unread_read&category=vault": () => [200, feed([])],
    });
    render(<NotificationBell />);
    await openHub();
    fireEvent.click(screen.getByRole("tab", { name: /Action required/ }));
    expect(
      await screen.findByRole("tab", { name: /Action required/, selected: true }),
    ).toBeTruthy();
    await waitFor(() => expect(sent.some((s) => s.route === ACTION)).toBe(true));
    fireEvent.click(screen.getByRole("tab", { name: "All" }));
    fireEvent.change(screen.getByLabelText("Show"), { target: { value: "archived" } });
    await waitFor(() =>
      expect(sent.some((s) => s.route.endsWith("tab=all&state=archived"))).toBe(true),
    );
    fireEvent.change(screen.getByLabelText("Show"), { target: { value: "unread_read" } });
    fireEvent.change(screen.getByLabelText("Category"), { target: { value: "vault" } });
    await waitFor(() => expect(sent.some((s) => s.route.endsWith("&category=vault"))).toBe(true));
    expect(await screen.findByText("You're all caught up.")).toBeTruthy();
  });

  it("marks everything read", async () => {
    const sent = setup({ "POST /api/v1/notifications/read-all": () => [204, null] });
    render(<NotificationBell />);
    await openHub();
    fireEvent.click(screen.getByRole("button", { name: "Mark all read" }));
    await waitFor(() => expect(sent.some((s) => s.route.startsWith("POST"))).toBe(true));
    await waitFor(() => expect(screen.queryByTestId("unread-dot")).toBeNull());
  });

  it("archives one item and takes it off the list", async () => {
    const sent = setup({ [`PATCH /api/v1/notifications/${ID(2)}`]: () => [200, {}] });
    render(<NotificationBell />);
    const list = await openHub();
    fireEvent.click(await within(list).findByRole("button", { name: "Archive: Item 2" }));
    await waitFor(() => expect(within(list).queryByText("Item 2")).toBeNull());
    expect(sent.find((s) => s.route.startsWith("PATCH"))?.body).toEqual({ archived: true });
  });

  it("opens the deep link and marks the item read", async () => {
    const sent = setup({ [`PATCH /api/v1/notifications/${ID(2)}`]: () => [200, {}] });
    render(<NotificationBell />);
    const list = await openHub();
    fireEvent.click(await within(list).findByRole("button", { name: "Unread: Item 2" }));
    expect(window.location.hash).toBe(`#/t/${ID(52)}`);
    await waitFor(() =>
      expect(sent.find((s) => s.route.startsWith("PATCH"))?.body).toEqual({ read: true }),
    );
  });

  it("runs an inline action and shows Done", async () => {
    const sent = setup({
      [`POST /api/v1/notifications/${ID(1)}/act`]: () => [200, { result: "done" }],
    });
    render(<NotificationBell />);
    const list = await openHub();
    fireEvent.click(
      await within(list).findByRole("button", { name: "Approve plan: Approve the plan" }),
    );
    expect(await within(list).findByText("Done")).toBeTruthy();
    expect(within(list).queryByRole("button", { name: /Approve plan/ })).toBeNull();
    expect(sent.find((s) => s.route.endsWith("/act"))?.body).toEqual({ action: "approve_plan" });
  });

  it("follows a redirect from an action", async () => {
    setup({
      [`POST /api/v1/notifications/${ID(1)}/act`]: () => [
        200,
        { result: "redirect", url: "#/t/abc" },
      ],
    });
    render(<NotificationBell />);
    const list = await openHub();
    fireEvent.click(
      await within(list).findByRole("button", { name: "Approve plan: Approve the plan" }),
    );
    await waitFor(() => expect(window.location.hash).toBe("#/t/abc"));
  });

  it("says when the object is no longer available and does not navigate", async () => {
    setup({ [`PATCH /api/v1/notifications/${ID(2)}`]: () => [200, {}] }, [
      item(2, { available: false, actions: [{ id: "x", label: "Open", style: "primary" }] }),
    ]);
    render(<NotificationBell />);
    const list = await openHub();
    expect(await within(list).findByText("No longer available")).toBeTruthy();
    expect(within(list).queryByRole("button", { name: /^Open/ })).toBeNull();
    fireEvent.click(within(list).getByRole("button", { name: "Unread: Item 2" }));
    expect(window.location.hash).toBe("");
  });

  it("only follows in-app links", () => {
    window.location.hash = "";
    for (const bad of [
      "javascript:alert(1)",
      "data:text/html,x",
      "https://evil.example/x",
      "//evil.example",
      "#javascript:alert(1)",
    ]) {
      openLink(bad);
      expect(window.location.hash, bad).toBe("");
    }
    openLink("#/t/ok");
    expect(window.location.hash).toBe("#/t/ok");
  });

  it("reports a failed load", async () => {
    setup({ [ALL]: () => [500, { code: "X", message: "No." }] });
    render(<NotificationBell />);
    await openHub().catch(() => undefined);
    expect(await screen.findByRole("alert")).toBeTruthy();
  });
});

describe("keyboard", () => {
  it("n opens, arrows move, e archives, Enter opens, a switches tab", async () => {
    const sent = setup({
      [`PATCH /api/v1/notifications/${ID(2)}`]: () => [200, {}],
      [`PATCH /api/v1/notifications/${ID(3)}`]: () => [200, {}],
    });
    render(<NotificationBell />);
    await screen.findByRole("button", { name: "Notifications, 2 unread" });
    fireEvent.keyDown(document.body, { key: "n" });
    const list = await screen.findByRole("list", { name: "Notifications" });
    await within(list).findByText("Item 3");

    fireEvent.keyDown(document.body, { key: "ArrowDown" });
    await waitFor(() =>
      expect(within(list).getByText("Item 2").closest("li")?.hasAttribute("data-selected")).toBe(
        true,
      ),
    );
    fireEvent.keyDown(document.body, { key: "e" });
    await waitFor(() => expect(within(list).queryByText("Item 2")).toBeNull());
    expect(sent.find((s) => s.route === `PATCH /api/v1/notifications/${ID(2)}`)?.body).toEqual({
      archived: true,
    });

    fireEvent.keyDown(document.body, { key: "a" });
    expect(
      await screen.findByRole("tab", { name: /Action required/, selected: true }),
    ).toBeTruthy();
    fireEvent.keyDown(document.body, { key: "a" });
    expect(await screen.findByRole("tab", { name: "All", selected: true })).toBeTruthy();

    fireEvent.keyDown(document.body, { key: "ArrowDown" });
    fireEvent.keyDown(document.body, { key: "Enter" });
    await waitFor(() => expect(window.location.hash).toBe(`#/t/${ID(53)}`));
  });

  it("ignores plain keys while typing in a field", async () => {
    setup();
    render(<NotificationBell />);
    await screen.findByRole("button", { name: "Notifications, 2 unread" });
    const box = document.createElement("input");
    document.body.append(box);
    fireEvent.keyDown(box, { key: "n" });
    expect(screen.queryByRole("list", { name: "Notifications" })).toBeNull();
    box.remove();
  });
});
