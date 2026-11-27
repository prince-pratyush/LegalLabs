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
