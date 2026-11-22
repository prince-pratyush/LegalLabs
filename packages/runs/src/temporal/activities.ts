import { type ActivityDeps, createActivities, type RunRef } from "../activities.js";
import type { Failure } from "../lifecycle.js";

/** What the workflow can call; each takes the run's reference so a worker holds no state. */
export interface ActivityFns {
  begin(ref: RunRef): ReturnType<ReturnType<typeof createActivities>["begin"]>;
  setStatus(
    ref: RunRef,
    status: Parameters<ReturnType<typeof createActivities>["setStatus"]>[0],
    reason?: string,
  ): Promise<void>;
  setPaused(ref: RunRef, paused: boolean): Promise<void>;
  applyPlanEdits(ref: RunRef, edits: string | undefined): Promise<void>;
  runStep(ref: RunRef, ordinal: number): ReturnType<ReturnType<typeof createActivities>["runStep"]>;
  answer(ref: RunRef, stepId: string, answer: unknown, auto: boolean): Promise<void>;
  verify(ref: RunRef): ReturnType<ReturnType<typeof createActivities>["verify"]>;
  finish(ref: RunRef, status: "done" | "failed" | "cancelled", reason?: Failure): Promise<void>;
  abort(ref: RunRef, message: string): Promise<void>;
  fireSchedule(scheduleId: string, firedAt: string): Promise<void>;
}

export type ScheduleFirer = (scheduleId: string, firedAt: string) => Promise<void>;

export function createTemporalActivities(
  deps: ActivityDeps,
  fire: ScheduleFirer = async () => {},
): ActivityFns {
  const of = (ref: RunRef) => createActivities(deps, ref);
  return {
    begin: (ref) => of(ref).begin(),
    setStatus: (ref, s, r) => of(ref).setStatus(s, r),
    setPaused: (ref, p) => of(ref).setPaused(p),
    applyPlanEdits: (ref, e) => of(ref).applyPlanEdits(e),
    runStep: (ref, n) => of(ref).runStep(n),
    answer: (ref, id, a, auto) => of(ref).answer(id, a, auto),
    verify: (ref) => of(ref).verify(),
    finish: (ref, s, r) => of(ref).finish(s, r),
    abort: (ref, message) => of(ref).finish("failed", { code: "ENGINE_ERROR", message }),
    fireSchedule: fire,
  };
}
