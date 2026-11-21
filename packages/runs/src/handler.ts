import type { Plan, RunEvent } from "@legallabs/contracts";
import type { Failure, StepOutcome } from "./lifecycle.js";
import type { RunRow, RunStore, StepRecord } from "./store.js";

export type NewEvent = RunEvent extends infer E
  ? E extends RunEvent
    ? Omit<E, "seq">
    : never
  : never;

export interface RunContext {
  run: RunRow;
  store: RunStore;
  /** Saves an event on the run's log, in order. */
  emit(event: NewEvent): Promise<void>;
}

/**
 * What a kind of run does. Agents and workflows each supply one; the lifecycle around it is
 * shared. Every method must be safe to call again for the same step: a retry after a crash
 * must find its earlier result rather than spend twice.
 */
export interface RunHandler {
  plan(ctx: RunContext): Promise<{ plan: Plan; requiresApproval: boolean } | { fail: Failure }>;
  /** Does step `ordinal`. Record it with `store.beginStep` and `store.finishStep`. */
  step(ctx: RunContext, ordinal: number): Promise<StepOutcome>;
  /** Stores a person's answer (or an automatic skip) on the step that asked. */
  answer(ctx: RunContext, step: StepRecord, answer: unknown, auto: boolean): Promise<void>;
  /** Citation checks and the like, once all steps are done. */
  verify(ctx: RunContext): Promise<{ ok: true } | { ok: false; code: string; message: string }>;
  /** After the run ended, for audit and stats. Must not throw. */
  ended?(ctx: RunContext, status: "done" | "failed" | "cancelled", reason?: Failure): Promise<void>;
  /** Applies a person's edits to the plan before the run goes on. */
  planEdited?(ctx: RunContext, edits: string | undefined): Promise<void>;
}

export type HandlerRegistry = Partial<Record<RunRow["kind"], RunHandler>>;
