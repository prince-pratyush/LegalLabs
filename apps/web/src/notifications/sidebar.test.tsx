import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../App.js";
import { at, FakeSource, serve, signedIn } from "../testing.js";

describe("the workspace sidebar", () => {
  it("has the bell, wired to the live stream, and a Settings link", async () => {
    serve({
      ...signedIn,
      "GET /api/v1/notifications/unread-count": () => [200, { unread: 3, action_required: 1 }],
      "GET /api/v1/notification-settings": () => [200, { categories: [], include_content: false }],
    });
    at("#/");
    render(<App />);
    expect(await screen.findByRole("button", { name: "Notifications, 3 unread" })).toBeTruthy();
    expect(FakeSource.bell).toHaveLength(1);
    // Run streams are counted on their own, so the bell never shifts those tests.
    expect(FakeSource.all).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(window.location.hash).toBe("#/settings/notifications");
    expect(await screen.findByRole("heading", { name: "Email notifications" })).toBeTruthy();
  });
});
