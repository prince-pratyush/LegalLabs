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
  /** Files a Space lists for choosing and citing. */
  files_listed: 500,
  /** Files one extraction reads. Choosing more is refused, never silently cut. */
  documents_per_run: 200,
  /** Extractions one person can have going at once. */
  active_runs: 3,
  /** Files that cost one ask from the person's model budget. */
  documents_per_ask: 20,
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

/** A file facts can be taken from: in a vault shared with the Space, and open to the caller. */
export interface FactFile {
  document_id: string;
  version_id: string;
  name: string;
  vault_id: string;
  vault_name: string;
  page_count: number;
  /** False while the file is still being read in, or when it couldn't be. */
  ready: boolean;
}

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

export const FactExtractRequest = z
  .object({
    document_ids: ids(FACT_LIMITS.documents_per_run).min(1).optional(),
    vault_id: Id.optional(),
    folder_id: Id.optional(),
    issue_ids: ids(50).optional(),
  })
  .strict()
  .refine((r) => (r.document_ids === undefined) !== (r.vault_id === undefined), {
    message: "Choose files or a vault.",
  })
  .refine((r) => r.folder_id === undefined || r.vault_id !== undefined, {
    message: "A folder needs its vault.",
  });
export type FactExtractRequest = z.infer<typeof FactExtractRequest>;

export const FactExtractionState = z.enum([
  "queued",
  "running",
  "done",
  "partial",
  "failed",
  "cancelled",
]);
export type FactExtractionState = z.infer<typeof FactExtractionState>;

/** Why a file, or part of one, wasn't read. */
export const FactSkipReason = z.enum([
  "NOT_READY",
  "PARSE_FAILED",
  "NO_TEXT",
  "ACCESS_LOST",
  "MODEL_NOT_ALLOWED",
  "MODEL_UNAVAILABLE",
  "COST_LIMIT",
  "BAD_OUTPUT",
  "PAGE_TOO_LONG",
  "TOO_MANY_PAGES",
  "TOO_MANY_FACTS",
  "FAILED",
]);
export type FactSkipReason = z.infer<typeof FactSkipReason>;

export interface FactExtraction {
  run_id: string;
  space_id: string;
  state: FactExtractionState;
  /** True only when every chosen file was read to its last page. */
  complete: boolean;
  failure: string | null;
  documents_total: number;
  documents_read: number;
  documents_partial: number;
  documents_failed: number;
  documents_pending: number;
  facts_found: number;
  /** Facts thrown away because their quote wasn't on the page. */
  rejected_unverified: number;
  rejected_invalid: number;
  cost_usd: number;
  documents: {
    document_id: string;
    /** Null once the caller can no longer open the file. */
    name: string | null;
    state: "pending" | "read" | "partial" | "failed";
    reason: FactSkipReason | null;
    pages_total: number;
    pages_read: number;
    facts: number;
    rejected: number;
  }[];
  created_at: string;
  finished_at: string | null;
}
