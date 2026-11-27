import { z } from "zod";
import { Id } from "./id.js";
import { Text } from "./playbook.js";

// A Space's fact table: short statements, each tied to the exact words of a document.

export const FACT_LIMITS = {
  text_chars: 1000,
  quote_chars: 2000,
  citations: 10,
  entities_per_fact: 20,
  issues_per_fact: 20,
  name_chars: 200,
  aliases: 20,
  description_chars: 2000,
  page_size: 100,
  /** Names or issues a Space lists at once. */
  list_size: 2000,
} as const;

export const FactStatus = z.enum(["extracted", "confirmed", "disputed", "rejected"]);
export type FactStatus = z.infer<typeof FactStatus>;

export const FactSource = z.enum(["extracted", "manual"]);
export type FactSource = z.infer<typeof FactSource>;

export const DatePrecision = z.enum(["day", "month", "year", "unknown"]);
export type DatePrecision = z.infer<typeof DatePrecision>;

export const EntityKind = z.enum(["person", "org", "place", "other"]);
export type EntityKind = z.infer<typeof EntityKind>;

/** A real calendar day, written YYYY-MM-DD. */
export const FactDate = z
  .string()
  .regex(/^[1-9]\d{3}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
  }, "Not a date")
  .refine((value) => value < "9999", "Not a date");

export interface FactWhen {
  event_date: string | null;
  event_date_end: string | null;
  date_precision: DatePrecision;
}

/** Says what is wrong with a date and how exact it claims to be, or null when it holds together. */
export function factWhenProblem(when: FactWhen): string | null {
  if ((when.date_precision === "unknown") !== (when.event_date === null)) {
    return "A date needs a precision, and an undated fact has neither.";
  }
  if (when.event_date_end !== null) {
    if (when.event_date === null || when.event_date_end < when.event_date) {
      return "The end date is before the start.";
    }
  }
  return null;
}

const Words = (max: number) => Text(max).trim().min(1);
const FactText = Words(FACT_LIMITS.text_chars);
const ids = (max: number) =>
  z
    .array(Id)
    .max(max)
    .refine((list) => new Set(list).size === list.length, "Repeated id");

export const FactCitationInput = z
  .object({
    document_version_id: Id,
    page_no: z.number().int().min(1).max(100_000),
    quote: Words(FACT_LIMITS.quote_chars),
  })
  .strict();
export type FactCitationInput = z.infer<typeof FactCitationInput>;

export const FactCreate = z
  .object({
    text: FactText,
    event_date: FactDate.nullable().default(null),
    event_date_end: FactDate.nullable().default(null),
    date_precision: DatePrecision.default("unknown"),
    entity_ids: ids(FACT_LIMITS.entities_per_fact).default([]),
    issue_ids: ids(FACT_LIMITS.issues_per_fact).default([]),
    citations: z.array(FactCitationInput).min(1).max(FACT_LIMITS.citations),
  })
  .strict()
  .refine((f) => factWhenProblem(f) === null, { message: "Check the date.", path: ["event_date"] });
export type FactCreate = z.infer<typeof FactCreate>;

/** A date is changed whole: all three parts, or none. */
export const FactPatch = z
  .object({
    text: FactText.optional(),
    event_date: FactDate.nullable().optional(),
    event_date_end: FactDate.nullable().optional(),
    date_precision: DatePrecision.optional(),
    entity_ids: ids(FACT_LIMITS.entities_per_fact).optional(),
    issue_ids: ids(FACT_LIMITS.issues_per_fact).optional(),
  })
  .strict()
  .refine((p) => Object.keys(p).length > 0, "Nothing to change")
  .refine((p) => {
    const parts = [p.event_date, p.event_date_end, p.date_precision].filter((v) => v !== undefined);
    return parts.length === 0 || parts.length === 3;
  }, "Send the whole date");
export type FactPatch = z.infer<typeof FactPatch>;

export const FactStatusRequest = z.object({ status: FactStatus }).strict();

const Aliases = z.array(Words(FACT_LIMITS.name_chars)).max(FACT_LIMITS.aliases);

export const EntityCreate = z
  .object({
    kind: EntityKind,
    canonical_name: Words(FACT_LIMITS.name_chars),
    aliases: Aliases.default([]),
    role: Words(FACT_LIMITS.name_chars).nullable().default(null),
  })
  .strict();
export type EntityCreate = z.infer<typeof EntityCreate>;

export const EntityPatch = z
  .object({
    kind: EntityKind.optional(),
    canonical_name: Words(FACT_LIMITS.name_chars).optional(),
    aliases: Aliases.optional(),
    role: Words(FACT_LIMITS.name_chars).nullable().optional(),
    provisional: z.boolean().optional(),
  })
  .strict()
  .refine((p) => Object.keys(p).length > 0, "Nothing to change");
export type EntityPatch = z.infer<typeof EntityPatch>;

export const IssueCreate = z
  .object({
    name: Words(FACT_LIMITS.name_chars),
    description: Text(FACT_LIMITS.description_chars).default(""),
  })
  .strict();
export type IssueCreate = z.infer<typeof IssueCreate>;

export const IssuePatch = z
  .object({
    name: Words(FACT_LIMITS.name_chars).optional(),
    description: Text(FACT_LIMITS.description_chars).optional(),
  })
  .strict()
  .refine((p) => Object.keys(p).length > 0, "Nothing to change");
export type IssuePatch = z.infer<typeof IssuePatch>;

export interface FactEntity {
  id: string;
  kind: EntityKind;
  canonical_name: string;
  aliases: string[];
  role: string | null;
  provisional: boolean;
}

export interface FactIssue {
  id: string;
  name: string;
  description: string;
}

export interface FactCitation {
  citation_id: string;
  document_id: string;
  version_id: string;
  document_name: string;
  page_no: number;
  char_from: number;
  char_to: number;
  quote: string;
  verified: "ok";
}

export interface Fact extends FactWhen {
  id: string;
  space_id: string;
  text: string;
  status: FactStatus;
  source: FactSource;
  version_no: number;
  entity_ids: string[];
  issue_ids: string[];
  citations: FactCitation[];
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface FactVersion extends FactWhen {
  no: number;
  text: string;
  entity_ids: string[];
  issue_ids: string[];
  edited_by: string;
  at: string;
}

export interface FactAuditEntry {
  id: string;
  fact_id: string | null;
  actor_id: string;
  action: string;
  details: Record<string, unknown>;
  at: string;
}
