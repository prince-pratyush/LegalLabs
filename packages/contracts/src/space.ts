import { z } from "zod";
import { Id } from "./id.js";
import type { RunStatus } from "./run.js";
import type { Caller } from "./thread.js";

export const SPACE_LIMITS = {
  name: 120,
  taskName: 200,
  description: 10_000,
  comment: 5_000,
  instructions: 10_000,
  contextChars: 12_000,
  phases: 50,
  tasksPerPhase: 200,
  /** Minutes an author may edit their own comment. */
  commentEditMinutes: 15,
} as const;

export const SpaceKind = z.enum(["internal", "external"]);
export type SpaceKind = z.infer<typeof SpaceKind>;

export const SpaceRole = z.enum(["admin", "collaborator"]);
export type SpaceRole = z.infer<typeof SpaceRole>;

/** `none` is the absence of a grant, so it is not stored. */
export const SpaceLevel = z.enum(["view", "run", "edit", "full"]);
export type SpaceLevel = z.infer<typeof SpaceLevel>;

export const SpaceResourceType = z.enum([
  "vault",
  "playbook",
  "review_table",
  "thread",
  "agent",
  "workflow",
  "scan",
]);
export type SpaceResourceType = z.infer<typeof SpaceResourceType>;

const text = (max: number) =>
  z
    .string()
    .max(max)
    .refine((t) => !t.includes("\0"), "No NUL bytes");

export const SpaceContext = z.object({
  version: z.number().int().min(1),
  summary: text(2000).optional(),
  parties: z
    .array(
      z.object({
        name: text(200).min(1),
        role: text(100),
        counsel: text(200).optional(),
      }),
    )
    .max(20),
  key_dates: z.array(z.object({ label: text(120).min(1), date: z.string().date() })).max(50),
  standing_instructions: text(SPACE_LIMITS.instructions).optional(),
});
export type SpaceContext = z.infer<typeof SpaceContext>;

/** What an admin sends; the server owns `version`. */
export const SpaceContextInput = z
  .object({
    summary: text(2000).optional(),
    parties: SpaceContext.shape.parties,
    key_dates: SpaceContext.shape.key_dates,
    standing_instructions: text(SPACE_LIMITS.instructions).optional(),
  })
  .strict();
export type SpaceContextInput = z.infer<typeof SpaceContextInput>;

export const SpaceCustomisation = z
  .object({
    accent_color: z
      .string()
      .regex(/^#[0-9a-f]{6}$/i)
      .optional(),
    welcome_md: text(10_000).optional(),
    tz: z.string().max(64).optional(),
    /** Whether a task run may stop to ask the assigner a question (default true). */
    agent_runs_interactive: z.boolean().optional(),
  })
  .strict();
export type SpaceCustomisation = z.infer<typeof SpaceCustomisation>;

export const SpaceCreate = z
  .object({
    name: text(SPACE_LIMITS.name).trim().min(1),
    kind: SpaceKind.default("internal"),
    matter_id: Id.nullable().optional(),
    template_id: Id.optional(),
  })
  .strict();
export type SpaceCreate = z.infer<typeof SpaceCreate>;

export const SpacePatch = z
  .object({
    name: text(SPACE_LIMITS.name).trim().min(1).optional(),
    customization: SpaceCustomisation.optional(),
  })
  .strict();
export type SpacePatch = z.infer<typeof SpacePatch>;

export const MemberInput = z
  .object({
    principal_type: z.enum(["user", "group"]),
    principal_id: Id,
    role: SpaceRole,
  })
  .strict();
export type MemberInput = z.infer<typeof MemberInput>;

export const ResourceInput = z
  .object({
    resource_type: SpaceResourceType,
    resource_id: Id,
    access: SpaceLevel,
  })
  .strict();
export type ResourceInput = z.infer<typeof ResourceInput>;

export const TaskStatus = z.enum(["todo", "in_progress", "done", "cancelled"]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const Assignee = z.discriminatedUnion("type", [
  z.object({ type: z.literal("user"), user_id: Id }).strict(),
  z.object({ type: z.literal("assistant") }).strict(),
  z.object({ type: z.literal("agent"), agent_id: Id }).strict(),
]);
export type Assignee = z.infer<typeof Assignee>;

const LinkedResource = z.object({ resource_type: SpaceResourceType, resource_id: Id });
export const TaskOutput = z.object({
  kind: z.enum(["message", "document", "table"]),
  id: Id,
});
export type TaskOutput = z.infer<typeof TaskOutput>;

export const TaskCreate = z
  .object({
    name: text(SPACE_LIMITS.taskName).trim().min(1),
    description_md: text(SPACE_LIMITS.description).optional(),
    assignee: Assignee.nullable().optional(),
    due_at: z.string().date().nullable().optional(),
    phase_id: Id.nullable().optional(),
    linked: z.array(LinkedResource).max(20).optional(),
    gate: z.boolean().optional(),
  })
  .strict();
export type TaskCreate = z.infer<typeof TaskCreate>;

export const TaskPatch = z
  .object({
    name: text(SPACE_LIMITS.taskName).trim().min(1).optional(),
    description_md: text(SPACE_LIMITS.description).optional(),
    assignee: Assignee.nullable().optional(),
    due_at: z.string().date().nullable().optional(),
    phase_id: Id.nullable().optional(),
    linked: z.array(LinkedResource).max(20).optional(),
    gate: z.boolean().optional(),
    status: TaskStatus.optional(),
  })
  .strict();
export type TaskPatch = z.infer<typeof TaskPatch>;

export const CommentInput = z
  .object({
    body_md: text(SPACE_LIMITS.comment).trim().min(1),
    mentions: z.array(Id).max(20).optional(),
  })
  .strict();
export type CommentInput = z.infer<typeof CommentInput>;

export const PhaseInput = z
  .object({ name: text(SPACE_LIMITS.name).trim().min(1), after_phase_id: Id.optional() })
  .strict();
export const PhasePatch = z
  .object({
    name: text(SPACE_LIMITS.name).trim().min(1).optional(),
    ordinal: z.number().int().min(1).max(SPACE_LIMITS.phases).optional(),
  })
  .strict();

/** What a Space keeps when saved as a template: its skeleton, never its people or content. */
export const SpaceTemplateDefinition = z.object({
  schema: z.literal("counsel.space-template/1"),
  phases: z
    .array(
      z.object({
        name: text(SPACE_LIMITS.name).min(1),
        tasks: z
          .array(
            z.object({
              name: text(SPACE_LIMITS.taskName).min(1),
              description: text(SPACE_LIMITS.description).optional(),
              gate: z.boolean().default(false),
              agent_id: Id.optional(),
            }),
          )
          .max(SPACE_LIMITS.tasksPerPhase),
      }),
    )
    .max(SPACE_LIMITS.phases),
  agents: z
    .array(z.object({ id: Id, level: z.enum(["run", "view"]).default("run") }))
    .max(50)
    .default([]),
  workflows: z
    .array(z.object({ id: Id, level: z.enum(["run", "view"]).default("run") }))
    .max(50)
    .default([]),
  vault_links: z
    .array(z.object({ id: Id, level: z.enum(["view", "edit"]).default("view") }))
    .max(20)
    .default([]),
  customization: z
    .object({
      accent_color: z
        .string()
        .regex(/^#[0-9a-f]{6}$/i)
        .optional(),
    })
    .default({}),
});
export type SpaceTemplateDefinition = z.infer<typeof SpaceTemplateDefinition>;

export const TemplateInput = z
  .object({
    name: text(SPACE_LIMITS.name).trim().min(1),
    description: text(1000).optional(),
    definition: SpaceTemplateDefinition.optional(),
    /** Instead of a definition: save this Space's skeleton. */
    from_space_id: Id.optional(),
    shared_to: z
      .object({ workspace: z.boolean(), group_ids: z.array(Id).max(50) })
      .strict()
      .optional(),
  })
  .strict()
  .refine((t) => (t.definition === undefined) !== (t.from_space_id === undefined), {
    message: "Give a definition or a Space to save, not both",
  });
export type TemplateInput = z.infer<typeof TemplateInput>;

/** Something a template could not carry over, so nothing is dropped without a word. */
export const Skipped = z.object({
  kind: z.enum(["agent", "workflow", "vault"]),
  id: Id,
  reason: z.enum(["wall", "not_shared", "not_found"]),
});
export type Skipped = z.infer<typeof Skipped>;

// --- The port to the run engine ---------------------------------------------------------------

/** What a run for a task reports. `outputs` are references; the content lives with the run. */
export interface TaskRunState {
  status: RunStatus;
  /** A line for the "Completed: …" comment. */
  summary?: string;
  /** The question an interactive run is waiting on, if any. */
  question?: string;
  outputs: { kind: "message" | "document" | "table"; id: string }[];
  /** Why it failed or stopped, when it did. */
  error?: string;
}

export interface TaskRunStart {
  taskId: string;
  spaceId: string;
  assignee: { type: "assistant" } | { type: "agent"; agentId: string };
  /** Task name, description, linked resources and the Space Context, already assembled. */
  prompt: string;
  /** Whether the run may stop and ask the assigner a question. */
  interactive: boolean;
}

/**
 * How Spaces starts work for a task. The run engine implements this against Temporal; until it
 * lands, `scriptedTaskRuns` in the API stands in. The engine tells Spaces a run ended by calling
 * `runFinished(runId)`; Spaces then reads `status` once and settles the task, so a missed call
 * heals the next time the task is read.
 */
export interface TaskRunPort {
  start(caller: Caller, input: TaskRunStart): Promise<{ runId: string; threadId: string }>;
  status(caller: Caller, runId: string): Promise<TaskRunState>;
  /** Idempotent; cancelling a finished run is not an error. */
  cancel(caller: Caller, runId: string): Promise<void>;
  /** Sends an answer to a run that asked a question; it throws if the run can't take it. */
  answer(caller: Caller, runId: string, answer: string): Promise<void>;
}

// --- Space Context injection ------------------------------------------------------------------

const escapeXml = (value: string) =>
  value.replace(/[<>&]/g, (c) => (c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;"));

const CUT = " [truncated]";

/**
 * The block prepended to every run inside a Space (spec §4.2): deterministic, no model call.
 * Kept within `max` characters: when over, the summary, then dates, then parties are dropped from
 * the end, and the standing instructions are cut last, with a marker.
 */
export function renderSpaceContext(
  space: { name: string; matterDisplay: string | null; context: SpaceContext },
  max: number = SPACE_LIMITS.contextChars,
): string {
  const { context } = space;
  const head = `<space_context space="${escapeXml(space.name)}" matter="${escapeXml(
    space.matterDisplay ?? "none",
  )}">`;
  const summary = context.summary ? [`  <summary>${escapeXml(context.summary)}</summary>`] : [];
  const parties = context.parties.map(
    (p) =>
      `  <parties>${escapeXml(p.name)} — ${escapeXml(p.role)}${
        p.counsel ? `; counsel: ${escapeXml(p.counsel)}` : ""
      }</parties>`,
  );
  const dates = context.key_dates.map(
    (d) => `  <key_dates>${escapeXml(d.label)}: ${d.date}</key_dates>`,
  );
  const open = "  <standing_instructions>";
  const shut = "</standing_instructions>";
  const instructions = context.standing_instructions
    ? escapeXml(context.standing_instructions)
    : null;
  const build = (body: string | null) =>
    [
      head,
      ...summary,
      ...parties,
      ...dates,
      ...(body === null ? [] : [`${open}${body}${shut}`]),
      "</space_context>",
    ].join("\n");

  // Least important first: the summary, then the dates, then the parties.
  for (const group of [summary, dates, parties]) {
    while (build(instructions).length > max && group.length > 0) group.pop();
  }
  const whole = build(instructions);
  if (whole.length <= max || instructions === null) return whole;
  const overflow = whole.length - max + CUT.length;
  return build(`${instructions.slice(0, Math.max(0, instructions.length - overflow))}${CUT}`);
}
