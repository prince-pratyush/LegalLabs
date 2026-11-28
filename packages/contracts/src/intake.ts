import { z } from "zod";
import { AssignmentRule } from "./ci.js";
import { Id } from "./id.js";
import { Text } from "./playbook.js";

// Intake request types and the requests made against them. The field, status and SLA rules
// live here so the API and the web app agree on them.

export const INTAKE_LIMITS = {
  fields: 20,
  options: 50,
  escalations: 10,
  conditions: 5,
  keyword_rules: 50,
  people: 50,
  attachments: 20,
  value_chars: 5000,
  reason_chars: 500,
  page_size: 50,
} as const;

const Name = (max: number) => Text(max).trim().min(1);
const Key = z
  .string()
  .max(60)
  .regex(/^[a-z_]+$/);

const Principal = z.union([
  z.object({ user_id: Id }).strict(),
  z.object({ group_id: Id }).strict(),
]);

export const IntakeFieldType = z.enum([
  "text",
  "select",
  "date",
  "money",
  "file",
  "matter",
  "boolean",
]);
export type IntakeFieldType = z.infer<typeof IntakeFieldType>;

export const IntakeFieldDef = z
  .object({
    key: Key,
    label: Name(200),
    type: IntakeFieldType,
    required: z.boolean(),
    options: z.array(Name(200)).max(INTAKE_LIMITS.options).optional(),
    /** How a requester is asked for it. */
    prompt: Text(500).default(""),
  })
  .strict()
  .refine((f) => f.type !== "select" || (f.options?.length ?? 0) > 0, {
    path: ["options"],
    error: "OPTIONS_REQUIRED",
  });
export type IntakeFieldDef = z.infer<typeof IntakeFieldDef>;

const Fields = z
  .array(IntakeFieldDef)
  .max(INTAKE_LIMITS.fields)
  .refine((fields) => new Set(fields.map((f) => f.key)).size === fields.length, {
    error: "DUPLICATE_KEY",
  });

// Conditions are data. Nothing here is ever evaluated as code.
const Condition = z.union([
  z.object({ field: Key, op: z.enum(["gt", "gte", "lt", "lte"]), value: z.number() }).strict(),
  z
    .object({
      field: Key,
      op: z.literal("eq"),
      value: z.union([Name(200), z.number(), z.boolean()]),
    })
    .strict(),
  z
    .object({
      field: Key,
      op: z.literal("in"),
      value: z
        .array(z.union([Name(200), z.number()]))
        .min(1)
        .max(100),
    })
    .strict(),
  z.object({ unassigned_for_hours: z.number().int().min(1).max(720) }).strict(),
  z.object({ sla: z.enum(["at_risk", "breached"]) }).strict(),
]);

export const IntakeEscalation = z
  .object({
    /** Every condition must hold. */
    when: z.array(Condition).min(1).max(INTAKE_LIMITS.conditions),
    action: z.enum(["reassign", "notify", "add_watcher"]),
    target: Principal,
  })
  .strict();
export type IntakeEscalation = z.infer<typeof IntakeEscalation>;

export const IntakeRouting = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("agent"),
      agent_id: Id,
      post_results_to_requester: z.boolean(),
    })
    .strict(),
  z.object({ kind: z.literal("contract_intelligence"), ci_agent_id: Id }).strict(),
  z
    .object({
      kind: z.literal("lawyer"),
      space_id: Id,
      assignment: z.array(AssignmentRule).max(20),
    })
    .strict(),
]);
export type IntakeRouting = z.infer<typeof IntakeRouting>;

const typeShape = {
  name: Name(100),
  description: Text(1000),
  fields: Fields,
  /** Null keeps requests of this type in the triage queue. */
  routing: IntakeRouting.nullable(),
  default_owners: z.array(Id).max(INTAKE_LIMITS.people),
  reviewers: z.array(Id).max(INTAKE_LIMITS.people),
  escalations: z.array(IntakeEscalation).max(INTAKE_LIMITS.escalations),
  sla_hours: z.number().int().min(1).max(720),
  awaiting_requester_timeout_hours: z.number().int().min(1).max(720),
  keyword_rules: z.array(Name(200)).max(INTAKE_LIMITS.keyword_rules),
};

export const IntakeTypeCreate = z
  .object({
    ...typeShape,
    description: typeShape.description.default(""),
    routing: typeShape.routing.default(null),
    default_owners: typeShape.default_owners.default([]),
    reviewers: typeShape.reviewers.default([]),
    escalations: typeShape.escalations.default([]),
    awaiting_requester_timeout_hours: typeShape.awaiting_requester_timeout_hours.default(72),
    keyword_rules: typeShape.keyword_rules.default([]),
  })
  .strict();
export type IntakeTypeCreate = z.input<typeof IntakeTypeCreate>;

export const IntakeTypePatch = z
  .object(typeShape)
  .partial()
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, { error: "EMPTY" });
export type IntakeTypePatch = z.input<typeof IntakeTypePatch>;

export const IntakeType = z.object({
  id: Id,
  ...typeShape,
  created_at: z.string(),
  updated_at: z.string(),
});
export type IntakeType = z.infer<typeof IntakeType>;

export const IntakeChannel = z.enum([
  "email",
  "slack",
  "teams",
  "jira",
  "servicenow",
  "gmail",
  "dms",
  "api",
]);
export type IntakeChannel = z.infer<typeof IntakeChannel>;

const Domain = z
  .string()
  .max(253)
  .toLowerCase()
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/);

const emailChannelShape = {
  name: Name(100),
  /** The intake address itself; mail from it is never taken. */
  address: z.email().max(320),
  /** The name the receiving server writes at the start of Authentication-Results. */
  authserv_id: z
    .string()
    .max(255)
    .regex(/^[A-Za-z0-9._-]+$/),
  /** Exact domains: a subdomain is listed on its own. */
  allowed_domains: z.array(Domain).min(1).max(50),
};

export const IntakeEmailChannelCreate = z.object(emailChannelShape).strict();
export type IntakeEmailChannelCreate = z.input<typeof IntakeEmailChannelCreate>;

export const IntakeEmailChannelPatch = z
  .object({ ...emailChannelShape, status: z.enum(["live", "disabled"]) })
  .partial()
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, { error: "EMPTY" });
export type IntakeEmailChannelPatch = z.input<typeof IntakeEmailChannelPatch>;

/** How long the old secret keeps working. Zero stops it at once, for one that leaked. */
export const IntakeSecretRotate = z
  .object({ grace_hours: z.number().int().min(0).max(72).default(24) })
  .strict();

export const IntakeEmailChannel = z.object({
  id: Id,
  ...emailChannelShape,
  status: z.enum(["live", "disabled"]),
  /** Where the mail server posts each message, on this server. */
  hook_path: z.string(),
  previous_secret_until: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type IntakeEmailChannel = z.infer<typeof IntakeEmailChannel>;

// Slack's own ids, so nothing else can be typed in where one is expected.
const SlackTeam = z.string().regex(/^T[A-Z0-9]{2,30}$/);
const SlackChannelId = z.string().regex(/^[CG][A-Z0-9]{2,30}$/);

const slackChannelShape = {
  name: Name(100),
  team_id: SlackTeam,
  /** Where a new request may be made from. */
  channel_ids: z.array(SlackChannelId).min(1).max(50),
};

/** Both come from the Slack app's own settings. They are kept sealed and never shown again. */
const SigningSecret = z.string().regex(/^[A-Za-z0-9_-]{16,200}$/);
const BotToken = z.string().regex(/^xoxb-[A-Za-z0-9-]{10,200}$/);

export const IntakeSlackChannelCreate = z
  .object({
    ...slackChannelShape,
    signing_secret: SigningSecret,
    /** Without one, requests are taken in but nothing is sent to Slack or fetched from it. */
    bot_token: BotToken.optional(),
  })
  .strict();
export type IntakeSlackChannelCreate = z.input<typeof IntakeSlackChannelCreate>;

export const IntakeSlackChannelPatch = z
  .object({
    ...slackChannelShape,
    signing_secret: SigningSecret,
    /** Null removes it. */
    bot_token: BotToken.nullable(),
    status: z.enum(["live", "disabled"]),
  })
  .partial()
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, { error: "EMPTY" });
export type IntakeSlackChannelPatch = z.input<typeof IntakeSlackChannelPatch>;

export const IntakeSlackChannel = z.object({
  id: Id,
  ...slackChannelShape,
  has_bot_token: z.boolean(),
  status: z.enum(["live", "disabled"]),
  /** The request URL for events, the slash command and the message shortcut, on this server. */
  hook_path: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type IntakeSlackChannel = z.infer<typeof IntakeSlackChannel>;

export const IntakeStatus = z.enum([
  "new",
  "unclassified",
  "awaiting_requester",
  "triaged",
  "in_progress",
  "waiting_approval",
  "done",
  "closed",
]);
export type IntakeStatus = z.infer<typeof IntakeStatus>;

const MOVES: Record<IntakeStatus, readonly IntakeStatus[]> = {
  new: ["unclassified", "awaiting_requester", "triaged", "closed"],
  unclassified: ["awaiting_requester", "triaged", "closed"],
  awaiting_requester: ["triaged", "closed"],
  triaged: ["awaiting_requester", "in_progress", "closed"],
  in_progress: ["awaiting_requester", "waiting_approval", "done", "closed"],
  waiting_approval: ["in_progress", "done", "closed"],
  done: [],
  closed: [],
};

export const intakeCanMove = (from: IntakeStatus, to: IntakeStatus) => MOVES[from].includes(to);
export const intakeNextStatuses = (from: IntakeStatus) => MOVES[from];
export const intakeIsOpen = (status: IntakeStatus) => status !== "done" && status !== "closed";

export const IntakeStatusChange = z
  .object({
    status: IntakeStatus.exclude(["new", "unclassified"]),
    reason: Name(INTAKE_LIMITS.reason_chars).optional(),
  })
  .strict()
  .refine((c) => (c.status === "closed") === (c.reason !== undefined), {
    path: ["reason"],
    error: "REASON",
  });
export type IntakeStatusChange = z.infer<typeof IntakeStatusChange>;

export const IntakeFieldValue = z.union([Text(INTAKE_LIMITS.value_chars), z.number(), z.boolean()]);
export type IntakeFieldValue = z.infer<typeof IntakeFieldValue>;
export const IntakeFieldValues = z
  .record(Key, IntakeFieldValue)
  .refine((v) => Object.keys(v).length <= INTAKE_LIMITS.fields, { error: "TOO_MANY_FIELDS" });
export type IntakeFieldValues = z.infer<typeof IntakeFieldValues>;

export const IntakeRequestCreate = z
  .object({
    type_id: Id.optional(),
    /** Someone outside the platform: a name to answer, never an account. */
    requester: z
      .object({
        display_name: Name(200),
        email: z.email().max(320).optional(),
        external_user_id: Name(200).optional(),
      })
      .strict(),
    fields: IntakeFieldValues.default({}),
    attachments: z
      .array(Id)
      .max(INTAKE_LIMITS.attachments)
      .refine((ids) => new Set(ids).size === ids.length, { error: "DUPLICATE" })
      .default([]),
    /** Restricts the request to people who can open the matter. */
    matter_id: Id.optional(),
    /** The sender's own id for it; sending it twice is refused. */
    external_ref: Name(200).optional(),
  })
  .strict();
export type IntakeRequestCreate = z.input<typeof IntakeRequestCreate>;

export const IntakeAssign = z.object({ assignee_id: Id.nullable() }).strict();
export const IntakeSetType = z.object({ type_id: Id }).strict();

export const IntakeSlaState = z.enum(["ok", "at_risk", "breached"]);
export type IntakeSlaState = z.infer<typeof IntakeSlaState>;

export function intakeSlaState(created: Date, due: Date, now: Date): IntakeSlaState {
  if (now >= due) return "breached";
  const used = now.getTime() - created.getTime();
  return used >= 0.75 * (due.getTime() - created.getTime()) ? "at_risk" : "ok";
}

export interface IntakeEscalationContext {
  fields: IntakeFieldValues;
  assigned: boolean;
  created: Date;
  sla: IntakeSlaState;
  now: Date;
}

/** Whether every condition holds. A field that is missing or of another kind holds nothing. */
export function intakeEscalationHolds(
  when: IntakeEscalation["when"],
  context: IntakeEscalationContext,
): boolean {
  return when.every((condition) => {
    if ("sla" in condition) {
      return context.sla === "breached" || context.sla === condition.sla;
    }
    if ("unassigned_for_hours" in condition) {
      const hours = (context.now.getTime() - context.created.getTime()) / 3_600_000;
      return !context.assigned && hours >= condition.unassigned_for_hours;
    }
    const value = Object.hasOwn(context.fields, condition.field)
      ? context.fields[condition.field]
      : undefined;
    if (value === undefined) return false;
    if (condition.op === "eq") return value === condition.value;
    if (condition.op === "in") return (condition.value as unknown[]).includes(value);
    if (typeof value !== "number") return false;
    if (condition.op === "gt") return value > condition.value;
    if (condition.op === "gte") return value >= condition.value;
    if (condition.op === "lt") return value < condition.value;
    return value <= condition.value;
  });
}

export const IntakeMerge = z.object({ into_request_id: Id }).strict();
export const IntakeEscalate = z
  .object({ to: Principal, note: Text(INTAKE_LIMITS.reason_chars).default("") })
  .strict();
export type IntakeEscalate = z.infer<typeof IntakeEscalate>;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (value: string) => {
  if (!DATE.test(value)) return false;
  const at = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(at.getTime()) && at.toISOString().startsWith(value);
};
const isId = (value: unknown) => typeof value === "string" && Id.safeParse(value).success;

function fits(def: IntakeFieldDef, value: IntakeFieldValue): boolean {
  switch (def.type) {
    case "text":
      return typeof value === "string";
    case "select":
      return typeof value === "string" && (def.options ?? []).includes(value);
    case "date":
      return typeof value === "string" && isDate(value);
    case "money":
      return typeof value === "number" && Number.isFinite(value) && value >= 0;
    case "boolean":
      return typeof value === "boolean";
    case "file":
    case "matter":
      return isId(value);
  }
}

/** Which required fields are still unanswered, and which values the type can't take. */
export function intakeCheckFields(
  defs: readonly IntakeFieldDef[],
  values: IntakeFieldValues,
): { missing: string[]; invalid: string[] } {
  const answered = (key: string) => {
    const value = values[key];
    return value !== undefined && !(typeof value === "string" && value.trim() === "");
  };
  const byKey = new Map(defs.map((d) => [d.key, d]));
  const invalid = Object.keys(values).filter((key) => {
    const def = byKey.get(key);
    return !def || (answered(key) && !fits(def, values[key] as IntakeFieldValue));
  });
  const missing = defs
    .filter((d) => d.required && (!answered(d.key) || invalid.includes(d.key)))
    .map((d) => d.key);
  return { missing, invalid };
}

export const IntakeAttachment = z.object({
  document_id: Id,
  name: z.string(),
  size: z.number(),
  /** The ingest state: a file is scanned before it can be read. */
  state: z.enum(["queued", "parsing", "indexed", "failed"]),
});
export type IntakeAttachment = z.infer<typeof IntakeAttachment>;

export const IntakeRequest = z.object({
  id: Id,
  number: z.number().int(),
  channel: IntakeChannel,
  external_ref: z.string(),
  requester: z.object({
    display_name: z.string(),
    email: z.string().nullable(),
    external_user_id: z.string(),
  }),
  type_id: Id.nullable(),
  type_name: z.string().nullable(),
  fields: z.record(z.string(), IntakeFieldValue),
  missing_fields: z.array(z.string()),
  status: IntakeStatus,
  closed_reason: z.string().nullable(),
  assignee_id: Id.nullable(),
  assignee_name: z.string().nullable(),
  matter_id: Id.nullable(),
  sla: z.object({ due_at: z.string(), state: IntakeSlaState }).nullable(),
  /** How sure the classifier was: 1 for a keyword rule, null when a person chose the type. */
  classification_confidence: z.number().nullable(),
  /** The lawyer's task; finishing it finishes the request. */
  task_id: Id.nullable(),
  /** The older request this one was combined into. */
  merged_into: Id.nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type IntakeRequest = z.infer<typeof IntakeRequest>;

export const IntakeEvent = z.object({
  id: Id,
  at: z.string(),
  kind: z.enum([
    "inbound",
    "outbound",
    "classified",
    "routed",
    "assigned",
    "status",
    "escalated",
    "sla",
    "merged",
  ]),
  actor_type: z.enum(["requester", "user", "system", "agent"]),
  actor_id: Id.nullable(),
  actor_name: z.string().nullable(),
  details: z.record(z.string(), z.unknown()),
});
export type IntakeEvent = z.infer<typeof IntakeEvent>;

export type IntakeRequestDetail = IntakeRequest & { attachments: IntakeAttachment[] };

/** Words sent back to an email requester. */
export const IntakeReply = z
  .object({ text: Text(INTAKE_LIMITS.value_chars).trim().min(1) })
  .strict();

export const IntakeMyTask = z.object({
  id: Id,
  space_id: Id,
  name: z.string(),
  /** A date, not a time. */
  due_at: z.string().nullable(),
  status: z.enum(["todo", "in_progress"]),
});
export type IntakeMyTask = z.infer<typeof IntakeMyTask>;

export interface IntakeMine {
  requests: IntakeRequest[];
  tasks: IntakeMyTask[];
}
