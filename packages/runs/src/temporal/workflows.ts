// Bundled by the Temporal worker: only deterministic code and imports that survive that.

import type { RunSignal } from "@legallabs/contracts";
import {
  condition,
  defineSignal,
  proxyActivities,
  setHandler,
  workflowInfo,
} from "@temporalio/workflow";
import type { RunRef } from "../activities.js";
import { type Activities, type LifecycleResult, runLifecycle } from "../lifecycle.js";
import { STEP_ATTEMPTS, STEP_TIMEOUT_MINUTES } from "../limits.js";
import type { ActivityFns } from "./activities.js";

const acts = proxyActivities<ActivityFns>({
  startToCloseTimeout: `${STEP_TIMEOUT_MINUTES} minutes`,
  retry: { maximumAttempts: STEP_ATTEMPTS, initialInterval: "1s", backoffCoefficient: 2 },
});

const SIGNALS = [
  "approve_plan",
  "reject_plan",
  "answer_question",
  "cancel",
  "pause",
  "resume",
] as const;
const signals = Object.fromEntries(SIGNALS.map((n) => [n, defineSignal<[RunSignal]>(n)]));

/** One agent, workflow or builder run: id `run:{run.id}`, signals as the spec names them. */
export async function agentRun(ref: RunRef): Promise<LifecycleResult> {
  const queue: RunSignal[] = [];
  for (const name of SIGNALS) {
    setHandler(signals[name] as ReturnType<typeof defineSignal<[RunSignal]>>, (s) => {
      queue.push(s);
    });
  }
  const act: Activities = {
    begin: () => acts.begin(ref),
    setStatus: (s, r) => acts.setStatus(ref, s, r),
    setPaused: (p) => acts.setPaused(ref, p),
    applyPlanEdits: (e) => acts.applyPlanEdits(ref, e),
    runStep: (n) => acts.runStep(ref, n),
    answer: (id, a, auto) => acts.answer(ref, id, a, auto),
    verify: () => acts.verify(ref),
    finish: (s, r) => acts.finish(ref, s, r),
  };
  try {
    return await runLifecycle(
      {
        act,
        now: () => Date.now(),
        signals: {
          poll: () => queue.shift(),
          async wait(ms) {
            const got = await condition(() => queue.length > 0, ms);
            return got ? (queue.shift() as RunSignal) : "timeout";
          },
        },
      },
      { kind: ref.kind, interactive: ref.interactive },
    );
  } catch (err) {
    // An activity gave up (the database was gone, a policy refused): end the run visibly.
    await acts.abort(ref, err instanceof Error ? err.message : "The run engine failed.");
    return { status: "failed", code: "ENGINE_ERROR" };
  }
}

/** What a Temporal Schedule starts: it asks the agents module to fire, which makes the run. */
export async function scheduledFire(arg: { scheduleId: string }): Promise<void> {
  await acts.fireSchedule(arg.scheduleId, workflowInfo().startTime.toISOString());
}
