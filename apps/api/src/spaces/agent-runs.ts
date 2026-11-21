import {
  type AgentRunPort,
  type RunStatus,
  RunStatus as RunStatuses,
  type TaskRunPort,
  type TaskRunState,
} from "@legallabs/contracts";

const known = (status: string): RunStatus => {
  const parsed = RunStatuses.safeParse(status);
  // A state this side doesn't know is still a run in progress.
  return parsed.success ? parsed.data : "running";
};

/**
 * Runs a Space task's agent through the run engine's `AgentRunPort` (path "task", linked to the
 * task), and anything that isn't an agent through `others`, which until the assistant has a run
 * path is the scripted stand-in. Which port holds a run is found by asking the engine first.
 */
export function agentTaskRuns(engine: AgentRunPort, others: TaskRunPort): TaskRunPort {
  return {
    async start(caller, input) {
      if (input.assignee.type !== "agent") return others.start(caller, input);
      const started = await engine.start(caller, {
        agent_id: input.assignee.agentId,
        path: "task",
        space_id: input.spaceId,
        task_id: input.taskId,
        // The engine puts the Space Context in front itself; the task text is the input.
        inputs: input.prompt.slice(0, 5000),
        interactive: input.interactive,
      });
      return { runId: started.run_id, threadId: started.thread_id };
    },

    async status(caller, runId) {
      const run = await engine.get(caller, runId);
      if (!run) return others.status(caller, runId);
      const state: TaskRunState = { status: known(run.status), outputs: [] };
      if (run.error_code) state.error = run.error_code;
      // The run's own thread holds what it wrote; the task links to that thread.
      if (run.thread_id && state.status === "done") {
        state.outputs = [{ kind: "message", id: run.thread_id }];
        state.summary = "The agent finished. Its answer is in the run's thread.";
      }
      return state;
    },

    async cancel(caller, runId) {
      const run = await engine.get(caller, runId);
      if (!run) return others.cancel(caller, runId);
      await engine.signal(caller, runId, { name: "cancel", reason: "the task was reassigned" });
    },

    async answer(caller, runId, answer) {
      const run = await engine.get(caller, runId);
      if (!run) return others.answer(caller, runId, answer);
      // Questions are answered on the run's own question step, which names its step id.
      throw new Error("answer the question in the run's thread");
    },
  };
}
