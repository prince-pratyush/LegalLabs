import { randomUUID } from "node:crypto";
import type { Caller, TaskRunPort, TaskRunStart, TaskRunState } from "@legallabs/contracts";

export interface ScriptedRun {
  runId: string;
  threadId: string;
  caller: Caller;
  input: TaskRunStart;
  state: TaskRunState;
  cancelled: boolean;
  answers: string[];
}

export interface ScriptedTaskRuns extends TaskRunPort {
  /** Every run started, in order, so a test can look at what Spaces asked for. */
  readonly runs: ScriptedRun[];
  /** Moves a run to a state, as the engine would; Spaces reads it on its next look. */
  finish(runId: string, state: Partial<TaskRunState> & Pick<TaskRunState, "status">): void;
}

export interface ScriptedOptions {
  /**
   * What a new run reports on its first look. The default finishes at once with a one-line
   * summary, which lets a task assigned to an agent complete and return without an engine.
   */
  firstLook?: (input: TaskRunStart) => TaskRunState;
  /** Makes `start` fail, to test that a refused start leaves the task unassigned. */
  failStart?: boolean;
  /** Runs while `start` is in flight, to test changes that land during a slow start. */
  duringStart?: () => Promise<void>;
  /** Makes `answer` throw, as an engine that can't take it would. */
  failAnswer?: boolean;
}

/**
 * Stands in for the run engine until Temporal-backed runs exist: it implements `TaskRunPort`
 * in memory. Nothing here calls a model, so it costs nothing and is safe in tests and demos.
 */
export function scriptedTaskRuns(options: ScriptedOptions = {}): ScriptedTaskRuns {
  const runs: ScriptedRun[] = [];
  const find = (runId: string) => {
    const run = runs.find((r) => r.runId === runId);
    if (!run) throw new Error(`no such run: ${runId}`);
    return run;
  };
  const firstLook =
    options.firstLook ??
    ((input: TaskRunStart): TaskRunState => ({
      status: "done",
      summary: `Scripted run finished the task for ${input.assignee.type}.`,
      outputs: [],
    }));

  return {
    runs,
    async start(caller, input) {
      if (options.failStart) throw new Error("the run engine is down");
      await options.duringStart?.();
      const run: ScriptedRun = {
        runId: randomUUID(),
        threadId: randomUUID(),
        caller,
        input,
        state: firstLook(input),
        cancelled: false,
        answers: [],
      };
      runs.push(run);
      return { runId: run.runId, threadId: run.threadId };
    },
    async status(_caller, runId) {
      return find(runId).state;
    },
    async cancel(_caller, runId) {
      const run = find(runId);
      run.cancelled = true;
      if (!["done", "failed", "cancelled"].includes(run.state.status)) {
        run.state = { ...run.state, status: "cancelled" };
      }
    },
    async answer(_caller, runId, answer) {
      if (options.failAnswer) throw new Error("the run engine is down");
      const run = find(runId);
      run.answers.push(answer);
      run.state = { status: "running", outputs: [] };
    },
    finish(runId, state) {
      const run = find(runId);
      run.state = { outputs: [], ...state };
    },
  };
}
