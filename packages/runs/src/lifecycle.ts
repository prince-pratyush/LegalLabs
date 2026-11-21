import type { RunSignal } from "@legallabs/contracts";
import { MAX_STEPS, TIMEOUT_MS } from "./limits.js";

export type RunStatusName =
  | "planned"
  | "awaiting_approval"
  | "running"
  | "awaiting_input"
  | "verifying"
  | "done"
  | "failed"
  | "cancelled";

export type StepOutcome =
  | { kind: "continue" }
  | { kind: "done" }
  | { kind: "ask"; step_id: string; allow_skip: boolean }
  | { kind: "fail"; code: string; message: string };

export type Failure = { code: string; message: string };

/** Every side effect of a run. Each call is safe to repeat: a retry finds the same result. */
export interface Activities {
  begin(): Promise<{ requiresApproval: boolean } | { fail: Failure }>;
  setStatus(status: RunStatusName, reason?: string): Promise<void>;
  setPaused(paused: boolean): Promise<void>;
  applyPlanEdits(edits: string | undefined): Promise<void>;
  runStep(ordinal: number): Promise<StepOutcome>;
  answer(stepId: string, answer: unknown, auto: boolean): Promise<void>;
  verify(): Promise<{ ok: true } | { ok: false; code: string; message: string }>;
  finish(status: "done" | "failed" | "cancelled", reason?: Failure): Promise<void>;
}

export interface SignalQueue {
  /** The next signal already waiting, if any. */
  poll(): RunSignal | undefined;
  /** Waits up to `ms` for a signal. */
  wait(ms: number): Promise<RunSignal | "timeout">;
}

export interface LifecycleEnv {
  act: Activities;
  signals: SignalQueue;
  now(): number;
}

export interface LifecycleInput {
  kind: "agent" | "workflow" | "agent_builder";
  interactive: boolean;
}

export type LifecycleResult = { status: "done" | "failed" | "cancelled"; code?: string };

/**
 * The run's state machine (agents-workflows.md §4.4). It holds no state a restart could lose
 * but what the activities persist, so a replay after a worker restart reaches the same place.
 * It must stay deterministic: no clocks or randomness except through `env`.
 */
export async function runLifecycle(
  env: LifecycleEnv,
  input: LifecycleInput,
): Promise<LifecycleResult> {
  const { act, signals } = env;
  let deadline = env.now() + (input.kind === "workflow" ? TIMEOUT_MS.workflow : TIMEOUT_MS.agent);
  const remaining = () => Math.max(0, deadline - env.now());
  // Time spent waiting for a person is theirs, not the run's: it doesn't count against the limit.
  const waitForPerson = async (ms: number) => {
    const from = env.now();
    const got = await signals.wait(ms);
    deadline += env.now() - from;
    return got;
  };

  const end = async (
    status: "done" | "failed" | "cancelled",
    reason?: Failure,
  ): Promise<LifecycleResult> => {
    await act.finish(status, reason);
    return reason ? { status, code: reason.code } : { status };
  };
  const cancelled = (reason?: string) =>
    end("cancelled", { code: "CANCELLED", message: reason ?? "cancelled" });

  const begun = await act.begin();
  if ("fail" in begun) return end("failed", begun.fail);

  if (begun.requiresApproval) {
    await act.setStatus("awaiting_approval");
    for (;;) {
      const sig = await waitForPerson(TIMEOUT_MS.approval);
      if (sig === "timeout") {
        return end("cancelled", { code: "approval_timeout", message: "No one approved the plan." });
      }
      if (sig.name === "approve_plan") {
        await act.applyPlanEdits(sig.edits);
        break;
      }
      if (sig.name === "reject_plan") {
        return end("cancelled", { code: "plan_rejected", message: sig.reason });
      }
      if (sig.name === "cancel") return cancelled(sig.reason);
    }
  }

  await act.setStatus("running");
  let paused = false;
  for (let ordinal = 0; ; ) {
    let sig = signals.poll();
    while (sig) {
      if (sig.name === "cancel") return cancelled(sig.reason);
      if (sig.name === "pause") paused = true;
      if (sig.name === "resume") paused = false;
      sig = signals.poll();
    }
    if (paused) {
      await act.setPaused(true);
      while (paused) {
        const next = await waitForPerson(TIMEOUT_MS.paused);
        if (next === "timeout") {
          return end("cancelled", { code: "pause_timeout", message: "The run stayed paused." });
        }
        if (next.name === "cancel") return cancelled(next.reason);
        if (next.name === "resume") paused = false;
      }
      await act.setPaused(false);
    }
    if (remaining() === 0) {
      return end("failed", { code: "RUN_TIMEOUT", message: "The run took too long." });
    }
    if (ordinal >= MAX_STEPS) {
      return end("failed", { code: "BUDGET_STEPS", message: "The run used all its steps." });
    }

    const out = await act.runStep(ordinal);
    if (out.kind === "fail") return end("failed", { code: out.code, message: out.message });
    if (out.kind === "done") break;
    if (out.kind === "continue") {
      ordinal += 1;
      continue;
    }

    // The step asked a question.
    if (!input.interactive) {
      if (!out.allow_skip) {
        return end("failed", {
          code: "NONINTERACTIVE_INPUT_REQUIRED",
          message: "The agent needs an answer and no one is there to give it.",
        });
      }
      await act.answer(out.step_id, { skip: true }, true);
      ordinal += 1;
      continue;
    }
    await act.setStatus("awaiting_input");
    let answered = false;
    while (!answered) {
      const next = await waitForPerson(TIMEOUT_MS.input);
      if (next === "timeout") {
        return end("cancelled", { code: "input_timeout", message: "No one answered in time." });
      }
      if (next.name === "cancel") return cancelled(next.reason);
      if (next.name === "answer_question" && next.step_id === out.step_id) {
        await act.answer(out.step_id, next.answer, false);
        answered = true;
      }
    }
    await act.setStatus("running");
    ordinal += 1;
  }

  await act.setStatus("verifying");
  const verdict = await act.verify();
  if (!verdict.ok) return end("failed", { code: verdict.code, message: verdict.message });
  return end("done");
}
