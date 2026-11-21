import type { RunSignal } from "@legallabs/contracts";
import { describe, expect, it } from "vitest";
import {
  type Activities,
  type LifecycleInput,
  runLifecycle,
  type StepOutcome,
} from "./lifecycle.js";
import { TIMEOUT_MS } from "./limits.js";

// Signals are scripted: each `wait` takes the next queued item, or times out and moves the clock.
function harness(script: {
  outcomes: StepOutcome[];
  approval?: boolean;
  verify?: boolean;
  stepMs?: number;
}) {
  const calls: string[] = [];
  let clock = 0;
  const queue: (RunSignal | "timeout")[] = [];
  const polled: RunSignal[] = [];
  const outcomes = [...script.outcomes];
  const act: Activities = {
    begin: async () => ({ requiresApproval: script.approval ?? false }),
    setStatus: async (s) => void calls.push(`status:${s}`),
    setPaused: async (p) => void calls.push(`paused:${p}`),
    applyPlanEdits: async (e) => void calls.push(`edits:${e}`),
    runStep: async (n) => {
      calls.push(`step:${n}`);
      clock += script.stepMs ?? 0;
      return outcomes.shift() ?? { kind: "done" };
    },
    answer: async (id, a, auto) => void calls.push(`answer:${id}:${JSON.stringify(a)}:${auto}`),
    verify: async () =>
      script.verify === false ? { ok: false, code: "VERIFY_FAILED", message: "no" } : { ok: true },
    finish: async (s, r) => void calls.push(`finish:${s}${r ? `:${r.code}` : ""}`),
  };
  const env = {
    act,
    now: () => clock,
    signals: {
      poll: () => polled.shift(),
      wait: async (ms: number) => {
        const next = queue.shift();
        if (next && next !== "timeout") return next;
        clock += ms;
        return "timeout" as const;
      },
    },
  };
  return {
    calls,
    queue,
    polled,
    run: (input: Partial<LifecycleInput> = {}) =>
      runLifecycle(env, { kind: "agent", interactive: true, ...input }),
  };
}

describe("runLifecycle", () => {
  it("goes straight to running, verifies and finishes", async () => {
    const h = harness({ outcomes: [{ kind: "continue" }, { kind: "done" }] });
    expect(await h.run()).toEqual({ status: "done" });
    expect(h.calls).toEqual([
      "status:running",
      "step:0",
      "step:1",
      "status:verifying",
      "finish:done",
    ]);
  });

  it("waits for plan approval, with edits", async () => {
    const h = harness({ outcomes: [], approval: true });
    h.queue.push({ name: "pause" }, { name: "approve_plan", edits: "only A" });
    expect(await h.run()).toEqual({ status: "done" });
    expect(h.calls.slice(0, 3)).toEqual([
      "status:awaiting_approval",
      "edits:only A",
      "status:running",
    ]);
  });

  it("cancels a rejected plan and one nobody approves in 7 days", async () => {
    const rejected = harness({ outcomes: [], approval: true });
    rejected.queue.push({ name: "reject_plan", reason: "too wide" });
    expect(await rejected.run()).toEqual({ status: "cancelled", code: "plan_rejected" });

    const ignored = harness({ outcomes: [], approval: true });
    expect(await ignored.run()).toEqual({ status: "cancelled", code: "approval_timeout" });
  });

  it("pauses and resumes between steps", async () => {
    const h = harness({ outcomes: [{ kind: "continue" }, { kind: "done" }] });
    h.polled.push({ name: "pause" });
    h.queue.push({ name: "resume" });
    expect(await h.run()).toEqual({ status: "done" });
    expect(h.calls.slice(0, 4)).toEqual([
      "status:running",
      "paused:true",
      "paused:false",
      "step:0",
    ]);
  });

  it("cancels at a step boundary", async () => {
    const h = harness({ outcomes: [{ kind: "continue" }, { kind: "continue" }] });
    h.polled.push({ name: "cancel", reason: "stop" });
    expect(await h.run()).toEqual({ status: "cancelled", code: "CANCELLED" });
    expect(h.calls).not.toContain("step:0");
  });

  it("asks, waits for the matching answer and goes on", async () => {
    const h = harness({
      outcomes: [{ kind: "ask", step_id: "q1", allow_skip: true }, { kind: "done" }],
    });
    h.queue.push(
      { name: "answer_question", step_id: "other", answer: { text: "no" } },
      { name: "answer_question", step_id: "q1", answer: { option_id: "a" } },
    );
    expect(await h.run()).toEqual({ status: "done" });
    expect(h.calls).toContain('answer:q1:{"option_id":"a"}:false');
    expect(h.calls).toContain("status:awaiting_input");
  });

  it("cancels a question nobody answers in 72 hours", async () => {
    const h = harness({ outcomes: [{ kind: "ask", step_id: "q1", allow_skip: true }] });
    expect(await h.run()).toEqual({ status: "cancelled", code: "input_timeout" });
  });

  it("skips a question when no one can answer, or fails if it cannot be skipped", async () => {
    const skip = harness({
      outcomes: [{ kind: "ask", step_id: "q1", allow_skip: true }, { kind: "done" }],
    });
    expect(await skip.run({ interactive: false })).toEqual({ status: "done" });
    expect(skip.calls).toContain('answer:q1:{"skip":true}:true');

    const need = harness({ outcomes: [{ kind: "ask", step_id: "q1", allow_skip: false }] });
    expect(await need.run({ interactive: false })).toEqual({
      status: "failed",
      code: "NONINTERACTIVE_INPUT_REQUIRED",
    });
  });

  it("fails on a step failure, a failed verification and the whole-run timeout", async () => {
    const step = harness({ outcomes: [{ kind: "fail", code: "BUDGET_COST", message: "over" }] });
    expect(await step.run()).toEqual({ status: "failed", code: "BUDGET_COST" });

    const verify = harness({ outcomes: [{ kind: "done" }], verify: false });
    expect(await verify.run()).toEqual({ status: "failed", code: "VERIFY_FAILED" });

    const steps = (n: number): StepOutcome[] => [
      ...Array.from({ length: n }, () => ({ kind: "continue" as const })),
      { kind: "done" },
    ];
    const slow = harness({ outcomes: steps(5), stepMs: TIMEOUT_MS.agent / 2 });
    expect(await slow.run()).toEqual({ status: "failed", code: "RUN_TIMEOUT" });
    const wf = harness({ outcomes: steps(5), stepMs: TIMEOUT_MS.agent / 2 });
    expect(await wf.run({ kind: "workflow" })).toEqual({ status: "done" });
    // Waiting for a person is not the run's time.
    const asked = harness({
      outcomes: [{ kind: "ask", step_id: "q", allow_skip: true }, { kind: "done" }],
      stepMs: TIMEOUT_MS.agent / 2,
    });
    asked.queue.push("timeout");
    expect((await asked.run()).code).toBe("input_timeout");
  });

  it("stops after 200 steps", async () => {
    const h = harness({
      outcomes: Array.from({ length: 300 }, () => ({ kind: "continue" as const })),
    });
    expect(await h.run()).toEqual({ status: "failed", code: "BUDGET_STEPS" });
  });
});
