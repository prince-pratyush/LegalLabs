import {
  type AgentRunPort,
  type Caller,
  type RunStatus,
  RunStatus as RunStatuses,
  type TaskRunPort,
  type TaskRunState,
} from "@legallabs/contracts";
import type pg from "pg";
import type { AgentRuns } from "../agent-runs/runs.js";
import { asApp, asWorker } from "../db.js";

const NO_CLIENT = { ip: null, userAgent: null };
const MAX_INPUT = 20_000;

const known = (status: string): RunStatus => {
  const parsed = RunStatuses.safeParse(status);
  // A state this side doesn't know is still a run in progress.
  return parsed.success ? parsed.data : "running";
};

/**
 * Space tasks on the run engine. An agent goes through `AgentRunPort`; the assistant is a run
 * of its own kind. Both call the model through the gateway.
 *
 * A run is its starter's, and only they can see it. The task is the Space's, so once a member
 * is shown to see the task, its run's state is read, and the run cancelled, as the starter.
 * Answers are not: only the starter's words may steer a run that acts with their rights, and a
 * tool call is never approved from here.
 */
export function createTaskRuns(
  pool: pg.Pool,
  deps: { port: AgentRunPort; runs: AgentRuns },
): TaskRunPort {
  const { port, runs } = deps;
  const principal = (caller: Caller) => ({ sessionId: "task", ...caller });

  /** The run's starter, if this caller can see the task it was started for. */
  async function starter(caller: Caller, runId: string): Promise<Caller> {
    const row = await asWorker(
      pool,
      async (db) =>
        (
          await db.query<{ owner_id: string; task_id: string }>(
            "select * from work.task_run_owner($1, $2)",
            [caller.workspaceId, runId],
          )
        ).rows[0],
    );
    const seen =
      row &&
      (await asApp(pool, principal(caller), async (db) => {
        const { rows } = await db.query("select 1 from work.task where id = $1", [row.task_id]);
        return rows.length > 0;
      }));
    // Unknown and unseen look alike; the task stays as it was and is read again later.
    if (!row || !seen) throw new Error("no such task run");
    return { workspaceId: caller.workspaceId, userId: row.owner_id };
  }

  const pendingStep = (who: Caller, runId: string) =>
    asApp(pool, principal(who), async (db) => {
      const { rows } = await db.query<{
        id: string;
        awaiting: string | null;
        question: string | null;
      }>(
        `select id, output ->> 'awaiting' as awaiting, output -> 'question' ->> 'text' as question
           from work.run_step where run_id = $1 and status = 'awaiting_user'
          order by ordinal desc limit 1`,
        [runId],
      );
      return rows[0] ?? null;
    });

  return {
    async start(caller, input) {
      const inputs = input.prompt.slice(0, MAX_INPUT);
      if (input.assignee.type === "agent") {
        const started = await port.start(caller, {
          agent_id: input.assignee.agentId,
          path: "task",
          space_id: input.spaceId,
          task_id: input.taskId,
          inputs,
          interactive: input.interactive,
        });
        return { runId: started.run_id, threadId: started.thread_id };
      }
      const matterId = await asApp(pool, principal(caller), async (db) => {
        const { rows } = await db.query<{ matter_id: string | null }>(
          "select matter_id from work.space where id = $1",
          [input.spaceId],
        );
        return rows[0]?.matter_id ?? null;
      });
      const started = await runs.start(principal(caller), {
        kind: "assistant",
        // What an assistant run works on is the task itself.
        subject_id: input.taskId,
        title: "Assistant task",
        inputs,
        path: "task",
        space_id: input.spaceId,
        task_id: input.taskId,
        interactive: input.interactive,
        ...(matterId ? { matter_id: matterId } : {}),
      });
      return { runId: started.run_id, threadId: started.thread_id };
    },

    async status(caller, runId) {
      const who = await starter(caller, runId);
      const run = await port.get(who, runId);
      if (!run) throw new Error("no such task run");
      const state: TaskRunState = { status: known(run.status), outputs: [] };
      if (run.error_code) state.error = run.error_code;
      if (state.status === "awaiting_input" || state.status === "awaiting_approval") {
        const step = await pendingStep(who, runId);
        // The arguments of a tool call stay with the person who has to approve them.
        state.question =
          !step || step.awaiting === "tool_approval"
            ? "The run is waiting for the person who started it to approve a step."
            : (step.question ?? "The run has a question.");
      }
      // The run's own thread holds what it wrote; the task links to that thread.
      if (run.thread_id && state.status === "done") {
        state.outputs = [{ kind: "message", id: run.thread_id }];
        state.summary = "The run finished. Its answer is in the run's thread.";
      }
      return state;
    },

    async cancel(caller, runId) {
      const who = await starter(caller, runId);
      await port.signal(who, runId, { name: "cancel", reason: "the task was reassigned" });
    },

    async answer(caller, runId, answer) {
      const who = principal(caller);
      const run = await runs.get(who, runId);
      const step = run && run.started_by === caller.userId && (await pendingStep(caller, runId));
      if (!step) throw new Error("only the person who started the run can answer it");
      if (step.awaiting === "tool_approval") {
        throw new Error("a tool call is approved on the run, not with a comment");
      }
      const sent = await runs.signal(
        who,
        runId,
        { name: "answer_question", step_id: step.id, answer: { text: answer.slice(0, 5000) } },
        NO_CLIENT,
      );
      if (sent !== "ok") throw new Error(`the run didn't take the answer: ${sent}`);
    },
  };
}
