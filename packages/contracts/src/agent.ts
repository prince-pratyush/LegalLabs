import { z } from "zod";
import { Id } from "./id.js";
import { FILE_KINDS, FileKind, Label, SOURCE_KINDS } from "./workflow.js";

export const AGENT_LIMITS = {
  title: 120,
  description: 1000,
  instructions: 20000,
  attachments: 50,
  sources: 5,
  practiceAreas: 10,
  /** A bare `.md` bundle. */
  markdownBytes: 1024 * 1024,
  bundleBytes: 50 * 1024 * 1024,
  bundleFiles: 50,
  shareReason: 500,
  cooldownDays: 7,
  inputs: 5000,
} as const;

const noNul = (text: string) => !text.includes("\0");
const text = (max: number) => z.string().trim().max(max).refine(noNul, "no NUL bytes");

export const AgentAttachment = z.object({
  label: Label,
  kind: FileKind,
  ref: z.string().min(1).max(200),
  name: z.string().max(300),
});
export type AgentAttachment = z.infer<typeof AgentAttachment>;

export const AgentSource = z.object({
  label: Label,
  kind: z.enum(SOURCE_KINDS),
  source: z.string().min(1).max(200),
  filters: z.record(z.string(), z.unknown()).optional(),
});
export type AgentSource = z.infer<typeof AgentSource>;

/** What a save sends. The limits come back as the spec's stable codes. */
export const AgentVersionInput = z.object({
  instructions: text(AGENT_LIMITS.instructions),
  attachments: z
    .array(AgentAttachment)
    .max(AGENT_LIMITS.attachments + 1)
    .default([]),
  sources: z
    .array(AgentSource)
    .max(AGENT_LIMITS.sources + 1)
    .default([]),
  promote: z.boolean().default(false),
});
export type AgentVersionInput = z.infer<typeof AgentVersionInput>;

export const AgentMode = z.enum(["describe", "scratch"]);
export const AgentStatus = z.enum(["draft", "live"]);
export type AgentStatus = z.infer<typeof AgentStatus>;

export const AgentPatch = z.object({
  title: text(AGENT_LIMITS.title).pipe(z.string().min(1)).optional(),
  description: text(AGENT_LIMITS.description).optional(),
  practice_areas: z.array(text(60)).max(AGENT_LIMITS.practiceAreas).optional(),
  auto_description: z.boolean().optional(),
});
export type AgentPatch = z.infer<typeof AgentPatch>;

// ---- access and sharing ----

/** Cumulative: each level holds those before it. */
export const ACCESS_LEVELS = ["run", "view", "edit", "full"] as const;
export const AccessLevel = z.enum(ACCESS_LEVELS);
export type AccessLevel = z.infer<typeof AccessLevel>;

export const atLeast = (have: AccessLevel | null, need: AccessLevel) =>
  have !== null && ACCESS_LEVELS.indexOf(have) >= ACCESS_LEVELS.indexOf(need);

export const SharePrincipalType = z.enum(["user", "group", "space", "workspace"]);
export type SharePrincipalType = z.infer<typeof SharePrincipalType>;

export const ShareRequestBody = z.object({
  principal_type: SharePrincipalType,
  principal_id: Id.optional(),
  level: AccessLevel,
});
export type ShareRequestBody = z.infer<typeof ShareRequestBody>;

export const ShareScope = z.enum([
  "individual",
  "group",
  "workspace",
  "internal_space",
  "external_space",
]);
export type ShareScope = z.infer<typeof ShareScope>;

export const scopeOf = (principal: SharePrincipalType, external: boolean): ShareScope =>
  principal === "user"
    ? "individual"
    : principal === "group"
      ? "group"
      : principal === "workspace"
        ? "workspace"
        : external
          ? "external_space"
          : "internal_space";

/** Admin switches under Configurations → Sharing. The workspace default is to ask. */
export const ApprovalConfig = z.object({
  individual: z.boolean().default(false),
  group: z.boolean().default(false),
  workspace: z.boolean().default(true),
});
export type ApprovalConfig = z.infer<typeof ApprovalConfig>;
export const DEFAULT_APPROVAL: ApprovalConfig = {
  individual: false,
  group: false,
  workspace: true,
};

export type Approver = "agents_admin" | "space_admin";

/**
 * Whether a share waits for someone, and for whom. Holders of `agents.admin` skip the
 * approval for what they share; so does a Space's own admin for that Space.
 */
export function approvalFor(
  config: ApprovalConfig,
  scope: ShareScope,
  requester: { agentsAdmin: boolean; spaceAdmin?: boolean },
): { required: false } | { required: true; approver: Approver } {
  const ask = { required: true, approver: "agents_admin" } as const;
  switch (scope) {
    case "individual":
      return config.individual && !requester.agentsAdmin ? ask : { required: false };
    case "group":
      return config.group && !requester.agentsAdmin ? ask : { required: false };
    case "workspace":
      return config.workspace && !requester.agentsAdmin ? ask : { required: false };
    case "internal_space":
      return { required: false };
    case "external_space":
      // Leaving the workspace is the Space admins' call, so an `agents.admin` does not skip it.
      return requester.spaceAdmin
        ? { required: false }
        : { required: true, approver: "space_admin" };
  }
}

export type LevelRefusal = "LEVEL_REQUIRES_BUILD_PERMISSION" | "GUEST_RUN_ONLY";

/** Edit and Full go only to builders; guests hold Run, and only through a Space. */
export function levelRefusal(
  level: AccessLevel,
  grantee: { build: boolean; guest: boolean },
  scope: ShareScope,
): LevelRefusal | null {
  if (grantee.guest) {
    return level !== "run" || (scope !== "internal_space" && scope !== "external_space")
      ? "GUEST_RUN_ONLY"
      : null;
  }
  if ((level === "edit" || level === "full") && !grantee.build) {
    return "LEVEL_REQUIRES_BUILD_PERMISSION";
  }
  return null;
}

export const ShareDecision = z.object({ reason: text(AGENT_LIMITS.shareReason).optional() });

// ---- schedules ----

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:MM");
const validZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

export const Schedule = z
  .object({
    rule: z.enum(["every_n_days", "weekly"]),
    params: z.object({
      n: z.number().int().min(1).max(90).optional(),
      /** 0 is Sunday. */
      weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
      inputs: text(AGENT_LIMITS.inputs).optional(),
    }),
    time_local: hhmm,
    tz: z.string().max(64).refine(validZone, "unknown time zone"),
    matter_id: Id.optional(),
    email: z.boolean().default(false),
    /** The day an every-N-days rule counts from, in `tz`. */
    anchor_date: z.iso.date().optional(),
  })
  .refine((s) => (s.rule === "every_n_days" ? s.params.n !== undefined : true), {
    message: "every_n_days needs n",
    path: ["params", "n"],
  })
  .refine((s) => (s.rule === "weekly" ? (s.params.weekdays?.length ?? 0) > 0 : true), {
    message: "weekly needs weekdays",
    path: ["params", "weekdays"],
  });
export type Schedule = z.infer<typeof Schedule>;

const zonedParts = (tz: string, ms: number) => {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return {
    y: Number(p.year),
    m: Number(p.month),
    d: Number(p.day),
    h: Number(p.hour),
    mi: Number(p.minute),
    s: Number(p.second),
  };
};
const offsetMs = (tz: string, ms: number) => {
  const p = zonedParts(tz, ms);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
};

/** The UTC instant of a wall-clock time in a zone; a time skipped by DST runs just after. */
function wallToUtc(tz: string, y: number, m: number, d: number, h: number, mi: number): number {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const first = guess - offsetMs(tz, guess);
  return guess - offsetMs(tz, first);
}

const DAY = 86_400_000;
const civilDay = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d) / DAY;

/** Whether the rule fires on a civil date; the Temporal schedule fires daily and asks this. */
export function firesOn(schedule: Schedule, y: number, m: number, d: number): boolean {
  if (schedule.rule === "weekly") {
    return (schedule.params.weekdays ?? []).includes(new Date(Date.UTC(y, m - 1, d)).getUTCDay());
  }
  const n = schedule.params.n ?? 1;
  const anchor = schedule.anchor_date;
  if (!anchor) return true;
  const [ay, am, ad] = anchor.split("-").map(Number) as [number, number, number];
  const days = civilDay(y, m, d) - civilDay(ay, am, ad);
  return days >= 0 && days % n === 0;
}

/** The first fire after `after`, as a UTC instant; null if the rule never fires within a year. */
export function nextScheduledRun(schedule: Schedule, after: Date): Date | null {
  const [h, mi] = schedule.time_local.split(":").map(Number) as [number, number];
  const start = zonedParts(schedule.tz, after.getTime());
  let day = civilDay(start.y, start.m, start.d);
  for (let i = 0; i < 400; i += 1, day += 1) {
    const date = new Date(day * DAY);
    const y = date.getUTCFullYear();
    const m = date.getUTCMonth() + 1;
    const d = date.getUTCDate();
    if (!firesOn(schedule, y, m, d)) continue;
    const at = wallToUtc(schedule.tz, y, m, d, h, mi);
    if (at > after.getTime()) return new Date(at);
  }
  return null;
}

// ---- skill bundles ----

export const SkillManifest = z.object({
  schema: z.literal("counsel.skill/1"),
  name: z.string().min(1).max(AGENT_LIMITS.title),
  description: z.string().max(AGENT_LIMITS.description).optional(),
  practice_areas: z.array(z.string().max(60)).max(AGENT_LIMITS.practiceAreas).default([]),
  instructions_path: z.string().max(300).default("SKILL.md"),
  attachments: z
    .array(
      z.object({
        label: z.string().regex(/^[a-z0-9_-]{1,40}$/),
        kind: z.enum(FILE_KINDS),
        path: z.string().max(300).optional(),
        ref: z.uuid().optional(),
        name: z.string().max(300).optional(),
      }),
    )
    .max(AGENT_LIMITS.attachments)
    .default([]),
  sources: z
    .array(
      z.object({
        label: z.string().regex(/^[a-z0-9_-]{1,40}$/),
        kind: z.enum(SOURCE_KINDS),
        source: z.string().min(1).max(200),
        filters: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .max(AGENT_LIMITS.sources)
    .default([]),
  defaults: z
    .object({
      response_mode: z.enum(["auto", "answer", "edit"]).default("auto"),
      deep_analysis: z.boolean().default(false),
    })
    .default({ response_mode: "auto", deep_analysis: false }),
  origin: z
    .object({ exported_from: z.string().max(200), agent_id: z.uuid(), version: z.number().int() })
    .optional(),
});
export type SkillManifest = z.infer<typeof SkillManifest>;

export const ImportIssue = z.object({
  kind: z.enum(["file", "source", "attachment"]),
  label: z.string(),
  status: z.enum(["ok", "unknown_source", "not_enabled", "too_large", "unsupported"]),
  detail: z.string().optional(),
});
export type ImportIssue = z.infer<typeof ImportIssue>;

export const ImportConfirm = z.object({
  title: text(AGENT_LIMITS.title).pipe(z.string().min(1)).optional(),
  drop_labels: z.array(z.string().max(60)).max(100).default([]),
});

// ---- nudges ----

export const NUDGE_THRESHOLD = 0.82;
export const NUDGE_SUPPRESS_DAYS = 30;
