import { z } from "zod";
import { Id } from "./id.js";
import type { Caller } from "./thread.js";

/** Run limits from the spec (§4.4); a workspace or matter policy may only lower them. */
export const RUN_LIMITS = {
  maxSteps: 200,
  defaultMaxTokens: 5_000_000,
  approvalDays: 7,
  inputHours: 72,
  stepMinutes: 15,
  stepAttempts: 3,
  agentHours: 6,
  workflowHours: 24,
  planApprovalSteps: 10,
  planApprovalDocuments: 25,
} as const;

export const StepKind = z.enum([
  "plan",
  "retrieve",
  "tool",
  "generate",
  "verify",
  "ask_user",
  "draft",
  "block",
]);
export type StepKind = z.infer<typeof StepKind>;

export const StepStatus = z.enum([
  "pending",
  "running",
  "awaiting_user",
  "done",
  "failed",
  "skipped",
]);
export type StepStatus = z.infer<typeof StepStatus>;

export const RoutingClass = z.enum(["extract", "draft", "summarise", "reason"]);
export type RoutingClass = z.infer<typeof RoutingClass>;

export const StepQuestion = z.object({
  text: z.string().max(2000),
  options: z.array(z.object({ id: z.string(), label: z.string().max(200) })).max(10),
  allow_text: z.boolean(),
  allow_skip: z.boolean(),
  answer: z.unknown().optional(),
});
export type StepQuestion = z.infer<typeof StepQuestion>;

/** One step of a run. Prompt and answer text live in object storage, never in these rows. */
export const RunStep = z.object({
  id: Id,
  run_id: Id,
  ordinal: z.number().int().min(0),
  parent_step_id: Id.nullable(),
  kind: StepKind,
  block_id: z.string().nullable(),
  label: z.string().nullable(),
  status: StepStatus,
  model: z
    .object({ provider: z.string(), model: z.string(), routing_class: z.string() })
    .nullable(),
  usage: z
    .object({
      input_tokens: z.number().int(),
      output_tokens: z.number().int(),
      cached_tokens: z.number().int(),
    })
    .nullable(),
  cost_usd: z.number().nullable(),
  started_at: z.iso.datetime(),
  finished_at: z.iso.datetime().nullable(),
  input: z.object({
    prompt_hash: z.string(),
    sources: z.array(z.object({ kind: z.string(), id: z.string(), label: z.string().optional() })),
    documents: z.array(
      z.object({
        document_id: Id,
        version_id: Id,
        pages: z.array(z.number().int()).optional(),
      }),
    ),
    tool: z
      .object({
        connector_id: Id,
        name: z.string(),
        args_hash: z.string(),
        policy_decision: z.enum(["allow", "ask", "block"]),
      })
      .optional(),
  }),
  output: z.object({
    summary: z.string().max(500),
    message_id: Id.optional(),
    artifact_ids: z.array(Id).default([]),
    citations: z
      .object({
        total: z.number().int(),
        verified: z.number().int(),
        mismatch: z.number().int(),
        unresolved: z.number().int(),
      })
      .optional(),
    question: StepQuestion.optional(),
    coverage: z
      .object({
        documents_in_scope: z.number().int(),
        documents_read: z.number().int(),
        pages_read: z.number().int(),
        fraction: z.number(),
      })
      .optional(),
  }),
  error: z.object({ code: z.string(), message: z.string(), retryable: z.boolean() }).nullable(),
});
export type RunStep = z.infer<typeof RunStep>;

/** Messages a person or the system sends a running run (spec §4.4). */
export const RunSignal = z.discriminatedUnion("name", [
  z.object({ name: z.literal("approve_plan"), edits: z.string().max(5000).optional() }),
  z.object({ name: z.literal("reject_plan"), reason: z.string().max(500) }),
  z.object({
    name: z.literal("answer_question"),
    step_id: z.string().min(1).max(100),
    answer: z.union([
      z.object({ option_id: z.string().max(100) }),
      z.object({ text: z.string().max(5000) }),
      z.object({ skip: z.literal(true) }),
    ]),
  }),
  z.object({ name: z.literal("cancel"), reason: z.string().max(500).default("cancelled") }),
  z.object({ name: z.literal("pause") }),
  z.object({ name: z.literal("resume") }),
]);
export type RunSignal = z.infer<typeof RunSignal>;
export type RunSignalName = RunSignal["name"];

export const RunPath = z.enum(["page", "mention", "word", "task", "schedule"]);
export type RunPath = z.infer<typeof RunPath>;

/** The body of `POST /agents/{id}/run`. */
export const AgentRunBody = z.object({
  thread_id: Id.optional(),
  matter_id: Id.optional(),
  space_id: Id.optional(),
  inputs: z.string().max(5000).optional(),
  version_id: Id.optional(),
});
export type AgentRunBody = z.infer<typeof AgentRunBody>;

export interface RunSummary {
  id: string;
  kind: "agent" | "workflow" | "agent_builder";
  subject_id: string;
  status: string;
  started_by: string;
  started_at: string;
  finished_at: string | null;
  cost_usd: number;
  test_mode: boolean;
  task_id: string | null;
  thread_id: string | null;
  error_code: string | null;
}

export type AgentRunErrorCode =
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "NOT_LIVE"
  | "WALL_DENIED"
  | "WALL_NO_ACCESSIBLE_CONTEXT"
  | "MODEL_POLICY_NO_ELIGIBLE_MODEL"
  | "INPUT_INVALID"
  | "GUEST_TASK_BLOCKED";

export interface AgentRunRequest {
  agent_id: string;
  path: RunPath;
  /** Pin a version; left out, the live one. Needs View access. */
  version_id?: string;
  inputs?: string;
  matter_id?: string;
  space_id?: string;
  /** Run in an existing thread (an `@agent` mention); otherwise a new one is made. */
  thread_id?: string;
  /** Set for a Space task assignee; the run's thread links back to it. */
  task_id?: string;
  /** False for scheduled runs and for tasks in a Space that turns questions off. */
  interactive?: boolean;
  test_mode?: boolean;
}

/**
 * How anything else starts and follows an agent run. Spaces and tasks use it for an
 * agent assignee: `start` with `path: "task"` and the task id, then read `get` until the
 * status is `done`, `failed` or `cancelled`. The run is checked against the caller's
 * rights, walls and the agent's live version exactly as a run from the Agents page.
 */
export interface AgentRunPort {
  /** Throws an `AgentRunError` with one of the codes above. */
  start(caller: Caller, request: AgentRunRequest): Promise<{ run_id: string; thread_id: string }>;
  get(caller: Caller, runId: string): Promise<RunSummary | null>;
  signal(caller: Caller, runId: string, signal: RunSignal): Promise<void>;
}

export class AgentRunError extends Error {
  constructor(
    readonly code: AgentRunErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "AgentRunError";
  }
}
