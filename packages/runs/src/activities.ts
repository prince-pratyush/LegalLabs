import type pg from "pg";
import type { HandlerRegistry, RunContext, RunHandler } from "./handler.js";
import type { Activities, Failure, StepOutcome } from "./lifecycle.js";
import { createRunStore, type RunRow, type RunStore } from "./store.js";

export interface RunRef {
  runId: string;
  workspaceId: string;
  userId: string;
  kind: RunRow["kind"];
  interactive: boolean;
  budget: { max_cost_usd: number | null; max_tokens: number };
}

export interface ActivityDeps {
  pool: pg.Pool;
  handlers: HandlerRegistry;
  /** Audit trail hook (agent.run.started and so on); the API supplies it. */
  audit?: (ref: RunRef, action: string, details: Record<string, unknown>) => Promise<void>;
  /** Tests make stores that fail on cue. */
  storeFor?: (ref: RunRef) => RunStore;
}

const OUTCOME = "_outcome";

/** The database half of a run. Each call is safe to repeat after a crash or a retry. */
export function createActivities(deps: ActivityDeps, ref: RunRef): Activities {
  const store =
    deps.storeFor?.(ref) ??
    createRunStore(deps.pool, { userId: ref.userId, workspaceId: ref.workspaceId }, ref.runId);
  const handler = (): RunHandler => {
    const h = deps.handlers[ref.kind];
    if (!h) throw new Error(`no handler for ${ref.kind} runs`);
    return h;
  };
  const context = async (): Promise<RunContext> => {
    const run = await store.run();
    if (!run) throw new Error("run not found");
    return {
      run,
      store,
      emit: async (event) => {
        const { type, ...data } = event;
        await store.event(type, data);
      },
    };
  };
  const audit = (action: string, details: Record<string, unknown>) =>
    deps.audit?.(ref, action, details).catch(() => {});

  const act: Activities = {
    async begin() {
      const ctx = await context();
      const stored = ctx.run.plan as { requires_approval?: boolean } | null;
      // A retry after the plan was saved reuses it instead of asking the model again.
      if (stored && ctx.run.status !== "planned") {
        return { requiresApproval: false };
      }
      if (stored) return { requiresApproval: stored.requires_approval === true };
      await audit("agent.run.started", { run_id: ref.runId, path: ctx.run.path });
      const planned = await handler().plan(ctx);
      if ("fail" in planned) return { fail: planned.fail };
      const plan = { ...planned.plan, requires_approval: planned.requiresApproval };
      await store.setPlan(plan);
      await ctx.emit({ type: "plan", plan });
      return { requiresApproval: planned.requiresApproval };
    },

    async setStatus(status, reason) {
      const ctx = await context();
      if (ctx.run.status === status) return;
      await store.setStatus(status);
      await ctx.emit({ type: "status", status, ...(reason ? { reason } : {}) });
    },

    async setPaused(paused) {
      await store.setPaused(paused);
    },

    async applyPlanEdits(edits) {
      const ctx = await context();
      await handler().planEdited?.(ctx, edits);
      await audit("run.plan_approved", { run_id: ref.runId });
    },

    async runStep(ordinal): Promise<StepOutcome> {
      const existing = await store.step(ordinal);
      const saved = existing?.output[OUTCOME] as StepOutcome | undefined;
      if (saved) return saved;
      if (existing?.status === "awaiting_user") {
        return {
          kind: "ask",
          step_id: existing.id,
          allow_skip: existing.output.allow_skip === true,
          ...(existing.output.awaiting === "approval" ? { approval: true } : {}),
        };
      }
      const totals = await store.totals();
      if (ref.budget.max_cost_usd !== null && totals.cost_usd >= ref.budget.max_cost_usd) {
        return { kind: "fail", code: "BUDGET_COST", message: "The run reached its cost limit." };
      }
      if (totals.tokens >= ref.budget.max_tokens) {
        return { kind: "fail", code: "BUDGET_TOKENS", message: "The run reached its token limit." };
      }
      const ctx = await context();
      const outcome = await handler().step(ctx, ordinal);
      if (outcome.kind === "continue" || outcome.kind === "done") {
        await store.mergeOutput(ordinal, { [OUTCOME]: outcome });
      }
      return outcome;
    },

    async answer(stepId, answer, auto) {
      const step = await store.stepById(stepId);
      if (!step || step.output[OUTCOME]) return;
      const ctx = await context();
      await handler().answer(ctx, step, answer, auto);
      await store.finishStep(step.ordinal, {
        status: auto ? "skipped" : "done",
        output: { [OUTCOME]: { kind: "continue" } },
      });
    },

    async verify() {
      return handler().verify(await context());
    },

    async finish(status, reason?: Failure) {
      const ctx = await context();
      if (["done", "failed", "cancelled"].includes(ctx.run.status)) return;
      await store.setStatus(status, reason?.code);
      await handler().ended?.(ctx, status, reason);
      await ctx.emit({ type: "status", status, ...(reason ? { reason: reason.code } : {}) });
      if (status === "failed" && reason) {
        await ctx.emit({
          type: "error",
          code: reason.code,
          message: reason.message,
          retryable: false,
        });
      }
      const totals = await store.totals();
      await audit("agent.run.finished", {
        run_id: ref.runId,
        status,
        steps: totals.steps,
        cost_usd: totals.cost_usd,
      });
    },
  };
  return act;
}
