import { fileURLToPath } from "node:url";
import { bundleWorkflowCode } from "@temporalio/worker";
import pg from "pg";
import { afterAll, describe, expect, inject, it } from "vitest";
import { seedRun } from "../fixture.js";
import type { RunHandler } from "../handler.js";
import { createRunStore } from "../store.js";
import { connectClient, createTemporalEngine } from "./engine.js";
import { toTemporalSpec } from "./schedules.js";
import { createRunWorker } from "./worker.js";

const workflowsPath = fileURLToPath(new URL("./workflows.ts", import.meta.url));

describe("temporal bundle and schedules", () => {
  it("bundles the workflow code, so nothing non-deterministic leaks in", async () => {
    const { code } = await bundleWorkflowCode({ workflowsPath });
    expect(code).toContain("agentRun");
    expect(code).not.toContain("node:pg");
  }, 120_000);

  it("maps weekly and every-N-days rules to wall-clock calendars in the zone", () => {
    const weekly = toTemporalSpec({
      rule: "weekly",
      params: { weekdays: [1, 4] },
      time_local: "08:00",
      tz: "Europe/London",
      email: false,
    });
    expect(weekly).toEqual({
      calendars: [{ hour: 8, minute: 0, dayOfWeek: ["MONDAY", "THURSDAY"] }],
      timezone: "Europe/London",
    });
    const every = toTemporalSpec({
      rule: "every_n_days",
      params: { n: 3 },
      time_local: "21:30",
      tz: "UTC",
      email: false,
    });
    expect(every.calendars).toEqual([{ hour: 21, minute: 30 }]);
  });
});

// Needs a Temporal server: CI starts one and sets TEMPORAL_ADDRESS.
describe.skipIf(!process.env.TEMPORAL_ADDRESS)("runs on Temporal", () => {
  const pool = new pg.Pool({ connectionString: inject("databaseUrl"), max: 6 });
  afterAll(() => pool.end());
  const address = process.env.TEMPORAL_ADDRESS ?? "";

  // Asks one question, then finishes; the calls are counted to prove nothing ran twice.
  const calls = { plan: 0, steps: [] as number[] };
  const handler: RunHandler = {
    async plan() {
      calls.plan += 1;
      return {
        plan: { steps: [], estimated_cost_usd: { low: 0, high: 0 }, editable: false },
        requiresApproval: false,
      };
    },
    async step(ctx, ordinal) {
      calls.steps.push(ordinal);
      const ask = ordinal === 1;
      const { step } = await ctx.store.beginStep({ ordinal, kind: ask ? "ask_user" : "generate" });
      if (ask) {
        await ctx.store.finishStep(1, { status: "awaiting_user", output: { allow_skip: true } });
        return { kind: "ask", step_id: step.id, allow_skip: true };
      }
      await ctx.store.finishStep(ordinal, { status: "done", cost_usd: 0.01 });
      return ordinal >= 2 ? { kind: "done" } : { kind: "continue" };
    },
    async answer(ctx, step, answer) {
      await ctx.store.mergeOutput(step.ordinal, { answer });
    },
    verify: async () => ({ ok: true }),
  };

  const startWorker = async (taskQueue: string) => {
    const worker = await createRunWorker({
      address,
      taskQueue,
      workflowsPath,
      deps: { pool, handlers: { agent: handler } },
    });
    return { worker, done: worker.run() };
  };

  it("resumes a run after the worker restarts while it waits for an answer", async () => {
    const taskQueue = `test-${Math.random().toString(36).slice(2)}`;
    const client = await connectClient({ address });
    const engine = createTemporalEngine(client, taskQueue);
    const ref = await seedRun(pool);
    const store = createRunStore(pool, ref, ref.runId);

    const first = await startWorker(taskQueue);
    await engine.start(ref);
    for (let i = 0; i < 200 && (await store.run())?.status !== "awaiting_input"; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect((await store.run())?.status).toBe("awaiting_input");

    // The worker dies mid-run.
    first.worker.shutdown();
    await first.done;
    const asking = await store.step(1);

    const second = await startWorker(taskQueue);
    await engine.signal(ref.runId, {
      name: "answer_question",
      step_id: asking?.id ?? "",
      answer: { text: "go on" },
    });
    expect(await engine.result(ref.runId)).toEqual({ status: "done" });
    second.worker.shutdown();
    await second.done;

    const run = await store.run();
    expect(run?.status).toBe("done");
    expect(run?.cost_usd).toBeCloseTo(0.02, 6);
    // Each step ran once; the plan was made once; the answer survived the restart.
    expect(calls.steps).toEqual([0, 1, 2]);
    expect(calls.plan).toBe(1);
    expect((await store.step(1))?.output).toMatchObject({ answer: { text: "go on" } });
  }, 120_000);

  it("starting the same run twice is one run, and a signal reaches it", async () => {
    const taskQueue = `test-${Math.random().toString(36).slice(2)}`;
    const client = await connectClient({ address });
    const engine = createTemporalEngine(client, taskQueue);
    const ref = await seedRun(pool);
    const w = await startWorker(taskQueue);
    await engine.start(ref);
    await engine.start(ref);
    const store = createRunStore(pool, ref, ref.runId);
    for (let i = 0; i < 200 && (await store.run())?.status !== "awaiting_input"; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
    }
    await engine.signal(ref.runId, { name: "cancel", reason: "no" });
    expect(await engine.result(ref.runId)).toEqual({ status: "cancelled", code: "CANCELLED" });
    w.worker.shutdown();
    await w.done;
  }, 120_000);
});
