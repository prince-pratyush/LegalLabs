import { describe, expect, it } from "vitest";
import { until, useStack } from "./session.js";

// Boots the built server.ts. Every other test builds its own app, so only this one notices a
// module the server stops creating, mounting or starting.
const { call, json, asOwner, workspace } = useStack();

type Overview = { dataAsOf: string | null; state: string };

describe("Command Center in the running server", () => {
  it("is mounted, and its materialisation job runs", async () => {
    // Nothing asks for a refresh, so only the job started by the server can fill this in.
    const overview = await until(
      () => json<Overview>("/api/v1/admin/analytics/overview"),
      (o) => o.dataAsOf !== null,
      "the first materialisation",
      30_000,
    );
    expect(overview.state).toBe("ready");
    expect((await call("/api/v1/admin/analytics/report")).status).toBe(200);
  });

  it("refuses someone without admin.reporting", async () => {
    const [role] = await asOwner<{ id: string; permissions: string[] }>(
      `select r.id, r.permissions from core.role r join core.workspace w on w.id = r.workspace_id
        join core."user" u on u.workspace_id = r.workspace_id and u.role_id = r.id
       where w.slug = $1`,
      [workspace()],
    );
    expect(role).toBeDefined();
    const set = (permissions: string[]) =>
      asOwner("update core.role set permissions = $2 where id = $1", [role?.id, permissions]);
    await set(["threads.use"]);
    try {
      expect((await call("/api/v1/admin/analytics/overview")).status).toBe(403);
    } finally {
      await set(role?.permissions ?? []);
    }
  });
});

describe("Contract Intelligence in the running server", () => {
  it("is mounted", async () => {
    expect(await json("/api/v1/apps/ci/agents")).toEqual({ agents: [] });
    expect(await json("/api/v1/apps/ci/reviews")).toEqual({ reviews: [], next_cursor: null });
  });
});

describe("Horizon scanning in the running server", () => {
  it("is mounted, and off until someone turns it on", async () => {
    expect(await json("/api/v1/horizon/settings")).toMatchObject({ enabled: false });
    expect((await call("/api/v1/horizon/scans")).status).toBe(403);
    // The routes that act on an item are there too, and as closed.
    const act = await call(`/api/v1/horizon/items/${crypto.randomUUID()}/draft-email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(act.status).toBe(403);
  });
});

describe("Web search in the running server", () => {
  it("is mounted, and off until set up and turned on", async () => {
    expect(await json("/api/v1/web-search/settings")).toMatchObject({
      configured: false,
      enabled: false,
    });
  });
});

describe("Intake in the running server", () => {
  it("is mounted", async () => {
    expect(await json("/api/v1/apps/intake/request-types")).toEqual({
      types: [],
      can_manage: true,
    });
    expect(await json("/api/v1/apps/intake/requests")).toEqual({
      requests: [],
      next_cursor: null,
    });
  });

  it("mounts the Slack channels, and their hook outside the session check", async () => {
    expect(await json("/api/v1/apps/intake/slack-channels")).toEqual({ channels: [] });
    const res = await call(`/hooks/slack/${"a".repeat(32)}`, { method: "POST" });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("mounts the email channels, and the hook outside the session check", async () => {
    expect(await json("/api/v1/apps/intake/channels")).toEqual({ channels: [] });
    expect(await json("/api/v1/apps/intake/my-tasks")).toEqual({ requests: [], tasks: [] });
    const res = await call(`/hooks/email/${"a".repeat(32)}`, { method: "POST" });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: "UNAUTHORIZED" });
  });
});

describe("Fact tables in the running server", () => {
  it("is mounted", async () => {
    const res = await call(`/api/v1/apps/chronology/spaces/${crypto.randomUUID()}/facts`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe("NOT_FOUND");
  });
});

describe("the Outlook pane in the running server", () => {
  it("is mounted, and wants one email", async () => {
    const res = await call("/api/v1/addins/outlook/items", { method: "POST" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("INVALID_REQUEST");
  });
});
