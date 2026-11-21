import pg from "pg";
import { afterAll, describe, expect, inject, it } from "vitest";
import { createActivities } from "./activities.js";
import { createLocalEngine } from "./engine.js";
import { seedRun } from "./fixture.js";
import type { RunHandler } from "./handler.js";
import { createRunStore } from "./store.js";

const pool = new pg.Pool({ connectionString: inject("databaseUrl"), max: 4 });
afterAll(() => pool.end());

// A scripted agent: no model, so no spend. Steps cost a fixed amount; step 1 asks a question.
function scripted(opts: { approval?: boolean; asks?: boolean } = {}) {
  const calls = { plan: 0, step: [] as number[] };
  const handler: RunHandler = {
    async plan() {
      calls.plan += 1;
      return {
        plan: {
          steps: [{ id: "s", title: "Do it", sources: [], estimate: { docs: 1, pages: 2 } }],
          estimated_cost_usd: { low: 0, high: 1 },
          editable: true,
        },
        requiresApproval: opts.approval ?? false,
      };
    },
    async step(ctx, ordinal) {
      calls.step.push(ordinal);
      const { step } = await ctx.store.beginStep({
        ordinal,
        kind: ordinal === 1 && opts.asks ? "ask_user" : "generate",
      });
      if (ordinal === 1 && opts.asks) {
        await ctx.store.finishStep(1, {
          status: "awaiting_user",
          output: { allow_skip: true, question: { text: "Which?" } },
        });
        await ctx.emit({
          type: "question",
          step_id: step.id,
          question: { text: "Which?", options: [], allow_text: true, allow_skip: true },
        });
        return { kind: "ask", step_id: step.id, allow_skip: true };
      }
      await ctx.store.finishStep(ordinal, {
        status: "done",
        model: "fake/model",
        routing_class: "draft",
        usage: { input_tokens: 100, output_tokens: 50 },
        cost_usd: 0.01,
      });
      return ordinal >= 2 ? { kind: "done" } : { kind: "continue" };
    },
    async answer(ctx, step, answer) {
      await ctx.store.mergeOutput(step.ordinal, { answer });
    },
    async verify() {
      return { ok: true };
    },
  };
  return { handler, calls };
}

const events = async (runId: string, ws: string, user: string) => {
  const store = createRunStore(pool, { userId: user, workspaceId: ws }, runId);
  void store;
  const { rows } = await pool.query<{ type: string; data: { status?: string } }>(
    "select type, data from work.run_event where run_id = $1 order by seq",
    [runId],
  );
  return rows;
};

describe("a run on the local engine", () => {
  it("plans, runs steps, asks, waits for the answer, verifies and finishes", async () => {
    const ref = await seedRun(pool);
    const { handler } = scripted({ asks: true });
    const engine = createLocalEngine({ pool, handlers: { agent: handler } });
    await engine.start(ref);
    const store = createRunStore(pool, ref, ref.runId);
    // Wait until it asks.
    for (let i = 0; i < 100 && (await store.run())?.status !== "awaiting_input"; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect((await store.run())?.status).toBe("awaiting_input");
    const asking = await store.step(1);
    expect(asking?.status).toBe("awaiting_user");

    await engine.signal(ref.runId, {
      name: "answer_question",
      step_id: asking?.id ?? "",
      answer: { text: "A" },
    });
    expect(await engine.result(ref.runId)).toEqual({ status: "done" });

    const run = await store.run();
    expect(run?.status).toBe("done");
    // The run's cost is the sum of its steps: two model steps at $0.01.
    expect(run?.cost_usd).toBeCloseTo(0.02, 6);
    const types = (await events(ref.runId, ref.workspaceId, ref.userId)).map(
      (e) => e.data.status ?? e.type,
    );
    expect(types).toEqual([
      "plan",
      "running",
      "question",
      "awaiting_input",
      "running",
      "verifying",
      "done",
    ]);
    expect((await store.step(1))?.output).toMatchObject({ answer: { text: "A" } });
  });

  it("waits for plan approval and runs on after approve_plan", async () => {
    const ref = await seedRun(pool);
    const { handler } = scripted({ approval: true });
    const engine = createLocalEngine({ pool, handlers: { agent: handler } });
    await engine.start(ref);
    const store = createRunStore(pool, ref, ref.runId);
    for (let i = 0; i < 100 && (await store.run())?.status !== "awaiting_approval"; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect((await store.run())?.status).toBe("awaiting_approval");
    await engine.signal(ref.runId, { name: "approve_plan" });
    expect((await engine.result(ref.runId)).status).toBe("done");
  });

  it("answers a question with a skip in a scheduled (non-interactive) run", async () => {
    const ref = await seedRun(pool, { interactive: false });
    const { handler } = scripted({ asks: true });
    const engine = createLocalEngine({ pool, handlers: { agent: handler } });
    await engine.start(ref);
    expect(await engine.result(ref.runId)).toEqual({ status: "done" });
    const step = await createRunStore(pool, ref, ref.runId).step(1);
    expect(step?.status).toBe("skipped");
    expect(step?.output).toMatchObject({ answer: { skip: true } });
  });

  it("cancels on signal and records why", async () => {
    const ref = await seedRun(pool);
    const { handler } = scripted({ approval: true });
    const engine = createLocalEngine({ pool, handlers: { agent: handler } });
    await engine.start(ref);
    await engine.signal(ref.runId, { name: "cancel", reason: "changed my mind" });
    expect(await engine.result(ref.runId)).toEqual({ status: "cancelled", code: "CANCELLED" });
    const run = await createRunStore(pool, ref, ref.runId).run();
    expect(run?.status).toBe("cancelled");
  });

  it("fails at the cost limit with the steps so far kept", async () => {
    const ref = { ...(await seedRun(pool)), budget: { max_cost_usd: 0.015, max_tokens: 1e9 } };
    const { handler } = scripted();
    const engine = createLocalEngine({ pool, handlers: { agent: handler } });
    await engine.start(ref);
    expect(await engine.result(ref.runId)).toEqual({ status: "failed", code: "BUDGET_COST" });
    expect((await createRunStore(pool, ref, ref.runId).totals()).steps).toBe(2);
  });
});

describe("activity retries", () => {
  it("repeating a step or the plan does no work twice and charges once", async () => {
    const ref = await seedRun(pool);
    const { handler, calls } = scripted();
    const act = createActivities({ pool, handlers: { agent: handler } }, ref);
    await act.begin();
    await act.begin();
    expect(calls.plan).toBe(1);
    await act.setStatus("running");
    await act.runStep(0);
    const again = await act.runStep(0);
    expect(again).toEqual({ kind: "continue" });
    expect(calls.step).toEqual([0]);
    const store = createRunStore(pool, ref, ref.runId);
    expect((await store.run())?.cost_usd).toBeCloseTo(0.01, 6);
  });

  it("stops a run's writes when its owner loses agents.use", async () => {
    const ref = await seedRun(pool);
    const { handler } = scripted();
    const act = createActivities({ pool, handlers: { agent: handler } }, ref);
    await act.begin();
    await pool.query(
      `update core.role set permissions = '{}' where id = (select role_id from core."user" where id = $1)`,
      [ref.userId],
    );
    await expect(act.setStatus("running")).rejects.toThrow();
  });
});
