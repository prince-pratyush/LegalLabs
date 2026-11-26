import { randomUUID } from "node:crypto";
import { createGateway } from "@legallabs/model-gateway";
import { createLocalEngine, type RunHandler } from "@legallabs/runs";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { createAuth } from "../auth/auth.js";
import { createDrafts } from "../drafts/drafts.js";
import { createTemplatePort } from "../library/port.js";
import {
  auditTrail,
  PASSWORD,
  type Seeded,
  seedMember,
  testDocuments,
  testPool,
  testThreads,
} from "../test-db.js";
import { createAgentRuns } from "./runs.js";

const pool = testPool();
afterAll(() => pool.end());

// Plans with approval, so the run stays put until someone signals it.
const waiting: RunHandler = {
  async plan() {
    return {
      plan: { steps: [], estimated_cost_usd: { low: 0, high: 0 }, editable: false },
      requiresApproval: true,
    };
  },
  async step(ctx, ordinal) {
    await ctx.store.beginStep({ ordinal, kind: "generate" });
    await ctx.store.finishStep(ordinal, {
      status: "done",
      cost_usd: 0.02,
      output: { summary: "wrote it", secret: "prompt text" },
    });
    return { kind: "done" };
  },
  answer: async () => {},
  verify: async () => ({ ok: true }),
};

function harness() {
  const engine = createLocalEngine({ pool, handlers: { agent: waiting, workflow: waiting } });
  const runs = createAgentRuns(pool, { engine });
  const documents = testDocuments(pool);
  const app = createApp({
    auth: createAuth(pool),
    documents,
    threads: testThreads(pool, documents),
    drafts: createDrafts(pool, {
      gateway: createGateway({ providers: {}, recordUsage: async () => {} }),
      templates: createTemplatePort(pool),
    }),
    agentRuns: runs,
    clientIp: () => "203.0.113.9",
  });
  const signIn = async (m: Pick<Seeded, "slug" | "email">) => {
    const res = await app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace: m.slug, email: m.email, password: PASSWORD }),
    });
    return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  };
  const call = async (cookie: string, method: string, path: string, json?: unknown) => {
    const res = await app.request(`/api/v1${path}`, {
      method,
      headers: { cookie, ...(json === undefined ? {} : { "content-type": "application/json" }) },
      ...(json === undefined ? {} : { body: JSON.stringify(json) }),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const principal = (m: Seeded) => ({ sessionId: randomUUID(), ...m });
  return { engine, runs, signIn, call, principal };
}

const status = async (runId: string) =>
  (await pool.query<{ status: string }>("select status from work.run where id = $1", [runId]))
    .rows[0]?.status;
const until = async (runId: string, want: string) => {
  for (let i = 0; i < 100 && (await status(runId)) !== want; i += 1) {
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe("agent run endpoints", () => {
  it("starts a run in a new thread, lists it, and signals it to the end", async () => {
    const h = harness();
    const ana = await seedMember(pool);
    const cookie = await h.signIn(ana);
    const started = await h.runs.start(h.principal(ana), {
      kind: "agent",
      subject_id: randomUUID(),
      title: "NDA review",
      inputs: "review this",
      path: "page",
    });
    await until(started.run_id, "awaiting_approval");

    const list = await h.call(cookie, "GET", "/runs?filter[kind]=agent");
    expect(list.body.runs.map((r: { id: string }) => r.id)).toEqual([started.run_id]);
    expect(list.body.runs[0]).toMatchObject({
      status: "awaiting_approval",
      started_by: ana.userId,
    });

    const signal = await h.call(cookie, "POST", `/runs/${started.run_id}/signal`, {
      name: "approve_plan",
    });
    expect(signal.status).toBe(202);
    expect((await h.engine.result(started.run_id)).status).toBe("done");

    const steps = await h.call(cookie, "GET", `/runs/${started.run_id}/steps`);
    expect(steps.body.steps).toHaveLength(1);
    expect(steps.body.steps[0]).toMatchObject({
      status: "done",
      summary: "wrote it",
      cost_usd: 0.02,
    });
    const full = await h.call(
      cookie,
      "GET",
      `/runs/${started.run_id}/steps/${steps.body.steps[0].id}`,
    );
    expect(full.body.step.output.secret).toBe("prompt text");

    const again = await h.call(cookie, "POST", `/runs/${started.run_id}/signal`, {
      name: "cancel",
    });
    expect(again.status).toBe(409);
    const trail = await auditTrail(pool, ana.workspaceId);
    expect(trail.map((e) => e.action)).toContain("run.signal");
  });

  it("hides runs and steps from other workspaces and refuses their signals", async () => {
    const h = harness();
    const ana = await seedMember(pool);
    const bob = await seedMember(pool);
    const started = await h.runs.start(h.principal(ana), {
      kind: "workflow",
      subject_id: randomUUID(),
      title: "W",
      path: "page",
    });
    const bobCookie = await h.signIn(bob);
    expect((await h.call(bobCookie, "GET", "/runs")).body.runs).toEqual([]);
    expect((await h.call(bobCookie, "GET", `/runs/${started.run_id}/steps`)).status).toBe(404);
    const sig = await h.call(bobCookie, "POST", `/runs/${started.run_id}/signal`, {
      name: "cancel",
    });
    expect(sig.status).toBe(404);
    await h.engine.signal(started.run_id, { name: "cancel", reason: "cleanup" });
    await h.engine.result(started.run_id);
  });

  it("stops the engine, not only the row, when a run is cancelled by id", async () => {
    const h = harness();
    const ana = await seedMember(pool);
    const cookie = await h.signIn(ana);
    const { run_id } = await h.runs.start(h.principal(ana), {
      kind: "agent",
      subject_id: randomUUID(),
      title: "Stop me",
      path: "page",
    });
    await until(run_id, "awaiting_approval");

    expect((await h.call(cookie, "POST", `/runs/${run_id}/cancel`)).status).toBe(202);
    const ended = await Promise.race([
      h.engine.result(run_id),
      new Promise((r) => setTimeout(() => r("still running"), 2_000)),
    ]);
    expect(ended).toMatchObject({ status: "cancelled" });
    expect(await status(run_id)).toBe("cancelled");
    expect((await h.call(cookie, "POST", `/runs/${run_id}/cancel`)).status).toBe(409);
  });

  it("refuses a signal nobody defined and a bad id", async () => {
    const h = harness();
    const ana = await seedMember(pool);
    const cookie = await h.signIn(ana);
    expect(
      (await h.call(cookie, "POST", `/runs/${randomUUID()}/signal`, { name: "explode" })).status,
    ).toBe(400);
    expect(
      (await h.call(cookie, "POST", "/runs/not-an-id/signal", { name: "cancel" })).status,
    ).toBe(404);
  });

  it("keeps test runs out of the list unless asked", async () => {
    const h = harness();
    const ana = await seedMember(pool);
    const cookie = await h.signIn(ana);
    const test = await h.runs.start(h.principal(ana), {
      kind: "agent",
      subject_id: randomUUID(),
      title: "T",
      path: "page",
      test_mode: true,
    });
    expect((await h.call(cookie, "GET", "/runs")).body.runs).toEqual([]);
    expect((await h.call(cookie, "GET", "/runs?test_mode=true")).body.runs).toHaveLength(1);
    await h.engine.signal(test.run_id, { name: "cancel", reason: "cleanup" });
    await h.engine.result(test.run_id);
  });
});
