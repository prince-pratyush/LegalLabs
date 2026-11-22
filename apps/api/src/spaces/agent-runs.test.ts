import type { AgentRunPort, RunSignal, RunSummary } from "@legallabs/contracts";
import { describe, expect, it } from "vitest";
import { agentTaskRuns } from "./agent-runs.js";
import { scriptedTaskRuns } from "./ports.js";

const caller = { workspaceId: "w", userId: "u" };
const summary = (over: Partial<RunSummary>): RunSummary => ({
  id: "run-1",
  kind: "agent",
  subject_id: "agent-1",
  status: "running",
  started_by: "u",
  started_at: "2026-11-21T00:00:00.000Z",
  finished_at: null,
  cost_usd: 0,
  test_mode: false,
  task_id: "task-1",
  thread_id: "thread-1",
  error_code: null,
  ...over,
});

function engine(state: Partial<RunSummary> = {}) {
  const signals: RunSignal[] = [];
  const requests: unknown[] = [];
  const port: AgentRunPort = {
    async start(_c, request) {
      requests.push(request);
      return { run_id: "run-1", thread_id: "thread-1" };
    },
    async get(_c, runId) {
      return runId === "run-1" ? summary(state) : null;
    },
    async signal(_c, _runId, signal) {
      signals.push(signal);
    },
  };
  return { port, signals, requests };
}

const start = {
  taskId: "task-1",
  spaceId: "space-1",
  prompt: "Task: review",
  interactive: false,
};

describe("agentTaskRuns", () => {
  it("starts an agent through the engine as a task run linked to the task", async () => {
    const e = engine();
    const runs = agentTaskRuns(e.port, scriptedTaskRuns());
    const started = await runs.start(caller, {
      ...start,
      assignee: { type: "agent", agentId: "agent-1" },
    });
    expect(started).toEqual({ runId: "run-1", threadId: "thread-1" });
    expect(e.requests[0]).toMatchObject({
      agent_id: "agent-1",
      path: "task",
      space_id: "space-1",
      task_id: "task-1",
      interactive: false,
    });
  });

  it("sends the assistant's work to the fallback, never the engine", async () => {
    const e = engine();
    const fallback = scriptedTaskRuns();
    const runs = agentTaskRuns(e.port, fallback);
    await runs.start(caller, { ...start, assignee: { type: "assistant" } });
    expect(e.requests).toHaveLength(0);
    expect(fallback.runs).toHaveLength(1);
  });

  it("reports a finished run with its thread as the output", async () => {
    const runs = agentTaskRuns(engine({ status: "done" }).port, scriptedTaskRuns());
    const state = await runs.status(caller, "run-1");
    expect(state.status).toBe("done");
    expect(state.outputs).toEqual([{ kind: "message", id: "thread-1" }]);
  });

  it("reports a failure's code and treats an unknown state as still running", async () => {
    const failed = agentTaskRuns(
      engine({ status: "failed", error_code: "MODEL_ERROR" }).port,
      scriptedTaskRuns(),
    );
    expect(await failed.status(caller, "run-1")).toMatchObject({
      status: "failed",
      error: "MODEL_ERROR",
    });
    const odd = agentTaskRuns(engine({ status: "warming_up" }).port, scriptedTaskRuns());
    expect((await odd.status(caller, "run-1")).status).toBe("running");
  });

  it("cancels through the engine's cancel signal", async () => {
    const e = engine();
    await agentTaskRuns(e.port, scriptedTaskRuns()).cancel(caller, "run-1");
    expect(e.signals[0]).toMatchObject({ name: "cancel" });
  });

  it("asks the fallback about a run the engine doesn't know", async () => {
    const fallback = scriptedTaskRuns();
    const runs = agentTaskRuns(engine().port, fallback);
    const started = await runs.start(caller, { ...start, assignee: { type: "assistant" } });
    fallback.finish(started.runId, { status: "done", summary: "ok" });
    expect((await runs.status(caller, started.runId)).summary).toBe("ok");
    await runs.cancel(caller, started.runId);
    expect(fallback.runs[0]?.cancelled).toBe(true);
  });
});
