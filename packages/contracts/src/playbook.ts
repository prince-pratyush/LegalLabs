import { z } from "zod";
import { Id } from "./id.js";

// Playbooks, playbook reviews and redlines (playbooks-word.md §4-5).
// The Word add-in and the web Editor both code against these shapes.

export const PLAYBOOK_LIMITS = {
  rules: 200,
  fallbacks: 5,
  actions: 10,
  /** Body characters; longer documents are refused with DOC_TOO_LARGE. */
  doc_chars: 1_000_000,
  /** Pages past which a review warns it will be slower and less accurate. */
  warn_pages: 100,
  /** Used to estimate pages when the host can't count them. */
  chars_per_page: 3_000,
  extra_context_chars: 4_000,
  extra_context_files: 5,
  alternates: 3,
} as const;

export const REVIEW_ERRORS = [
  "DOC_TOO_LARGE",
  "RULE_LIMIT",
  "DUPLICATE_RULE_TITLE",
  "REDLINE_NEEDS_DOCX",
  "MATTER_MISMATCH",
  "NOT_PUBLISHED",
  "ANCHOR_FAILED",
  "OOXML_INVALID",
  "NO_PARSEABLE_INPUT",
] as const;
export type ReviewError = (typeof REVIEW_ERRORS)[number];

// ---------- playbooks ----------

export const Action = z.object({
  scenario: z.string().min(1).max(500),
  instruction: z.string().min(1).max(2000),
});
export type Action = z.infer<typeof Action>;

export const FindingStatus = z.enum([
  "acceptable",
  "needs_review",
  "not_acceptable",
  "not_found",
  "skipped",
]);
export type FindingStatus = z.infer<typeof FindingStatus>;

export const Condition = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("paper"), equals: z.enum(["ours", "theirs"]) }),
  z.object({ kind: z.literal("party_role"), equals: z.string().min(1).max(100) }),
  // Governing law of the paper, e.g. US, EU, UK, AU.
  z.object({ kind: z.literal("jurisdiction"), in: z.array(z.string().min(2).max(10)).min(1) }),
  z.object({ kind: z.literal("rule_status"), rule_id: Id, equals: FindingStatus }),
]);
export type Condition = z.infer<typeof Condition>;

/** Where a generated rule came from, so the author can check it. */
export const Provenance = z.object({
  document_id: Id,
  quote: z.string().min(1).max(2000),
  verified: z.boolean(),
});

/** A rule as typed by an author or shipped in a starter; the server assigns ids. */
export const RuleInput = z.object({
  title: z.string().trim().min(1).max(200),
  standard_position: z.string().min(1).max(4000),
  fallbacks: z.array(z.string().min(1).max(4000)).max(PLAYBOOK_LIMITS.fallbacks).default([]),
  unacceptable: z.string().max(4000).optional(),
  guidance: z.string().max(4000).optional(),
  flag: z.boolean().default(false),
  actions: z.array(Action).max(PLAYBOOK_LIMITS.actions).default([]),
  condition: Condition.optional(),
  /** Model clause text used when the clause is missing or must be replaced. */
  sample_language: z.string().max(4000).optional(),
  provenance: Provenance.nullable().optional(),
});
export type RuleInput = z.input<typeof RuleInput>;

export const Rule = RuleInput.extend({ id: Id, ordinal: z.number().int().min(0) });
export type Rule = z.infer<typeof Rule>;

const uniqueTitles = (rules: readonly { title: string }[]) =>
  new Set(rules.map((r) => r.title.trim().toLowerCase())).size === rules.length;

export const RuleList = z
  .array(RuleInput)
  .max(PLAYBOOK_LIMITS.rules, { message: "RULE_LIMIT" })
  .refine(uniqueTitles, { message: "DUPLICATE_RULE_TITLE" });

export const PlaybookStatus = z.enum(["published", "unpublished"]);
export const PlaybookLevel = z.enum(["view", "edit", "manage"]);
export type PlaybookLevel = z.infer<typeof PlaybookLevel>;

export const StarterTemplate = z.enum(["nda", "msa"]);
export type StarterTemplate = z.infer<typeof StarterTemplate>;

export const Playbook = z.object({
  id: Id,
  workspace_id: Id,
  owner_id: Id,
  name: z.string().min(1).max(200),
  contract_type: z.string().min(1).max(100),
  guidance: z.string().max(8000).nullable(),
  status: PlaybookStatus,
  version_id: Id,
  version_no: z.number().int().min(1),
  rules: z.array(Rule).max(PLAYBOOK_LIMITS.rules),
  /** The caller's level on this playbook. */
  access: PlaybookLevel,
  created_at: z.string(),
  updated_at: z.string(),
});
export type Playbook = z.infer<typeof Playbook>;

export const PlaybookSummary = Playbook.omit({ rules: true }).extend({ rule_count: z.number() });
export type PlaybookSummary = z.infer<typeof PlaybookSummary>;

export const PlaybookCreate = z.object({
  name: z.string().trim().min(1).max(200),
  contract_type: z.string().trim().min(1).max(100),
  guidance: z.string().max(8000).optional(),
  source: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("scratch"), rules: RuleList.default([]) }),
    z.object({ kind: z.literal("starter"), template: StarterTemplate }),
    z.object({ kind: z.literal("playbook"), playbook_id: Id }),
    z.object({ kind: z.literal("document"), document_id: Id }),
  ]),
});
export type PlaybookCreate = z.input<typeof PlaybookCreate>;

export const PlaybookPatch = z
  .object({
    name: z.string().trim().min(1).max(200),
    contract_type: z.string().trim().min(1).max(100),
    guidance: z.string().max(8000).nullable(),
    rules: RuleList,
  })
  .partial();
export type PlaybookPatch = z.input<typeof PlaybookPatch>;

export const PlaybookVersion = z.object({
  version_id: Id,
  no: z.number().int().min(1),
  created_by: Id,
  created_at: z.string(),
  rule_count: z.number().int(),
});
export type PlaybookVersion = z.infer<typeof PlaybookVersion>;

export const PlaybookGrant = z.object({
  principal_type: z.enum(["user", "group"]),
  principal_id: Id,
  level: PlaybookLevel,
});
export type PlaybookGrant = z.infer<typeof PlaybookGrant>;

// ---------- reviews ----------

export const Paper = z.enum(["ours", "theirs"]);
export const ReviewMode = z.enum(["standard", "in_depth", "redline_only"]);

export const ReviewRequest = z.object({
  document_version_id: Id,
  party: z.string().max(200),
  paper: Paper.default("theirs"),
  mode: ReviewMode.default("standard"),
  scope: z.union([z.literal("all"), z.array(Id).min(1)]).default("all"),
  /** Governing law of the paper when known; picks jurisdiction-conditioned rules. */
  jurisdiction: z.string().min(2).max(10).optional(),
  extra_context: z
    .object({
      text: z.string().max(PLAYBOOK_LIMITS.extra_context_chars).optional(),
      document_ids: z.array(Id).max(PLAYBOOK_LIMITS.extra_context_files).default([]),
    })
    .optional(),
  surface: z.enum(["web", "word"]),
  thread_id: Id.optional(),
});
export type ReviewRequest = z.input<typeof ReviewRequest>;

export const Evidence = z.object({
  paragraph_index: z.number().int().min(0),
  section_path: z.string().optional(),
  char_from: z.number().int().min(0),
  char_to: z.number().int().min(0),
  quote: z.string(),
  verified: z.enum(["ok", "mismatch"]),
});
export type Evidence = z.infer<typeof Evidence>;

export const Anchor = z.object({
  paragraph_index: z.number().int().min(0),
  run_index: z.number().int().optional(),
  char_from: z.number().int().min(0),
  char_to: z.number().int().min(0),
  para_hash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type Anchor = z.infer<typeof Anchor>;

export const SuggestionStatus = z.enum([
  "pending",
  "applied",
  "dismissed",
  "superseded",
  "anchor_failed",
]);
export type SuggestionStatus = z.infer<typeof SuggestionStatus>;

export const Alternate = z.object({ id: Id, after: z.string(), justification: z.string() });

export const Suggestion = z.object({
  id: Id,
  rule_id: Id.nullable(),
  gap_id: Id.nullable().optional(),
  anchor: Anchor,
  /** "replace" swaps before for after; "insert_after" adds a paragraph after the anchor. */
  kind: z.enum(["replace", "insert_after"]),
  before: z.string(),
  after: z.string(),
  justification: z.string().max(2000),
  status: SuggestionStatus,
  applied_with_comment: z.boolean().optional(),
  decided_by: Id.optional(),
  decided_at: z.string().optional(),
  alternates: z.array(Alternate).max(PLAYBOOK_LIMITS.alternates).optional(),
});
export type Suggestion = z.infer<typeof Suggestion>;

export const Usage = z.object({ input_tokens: z.number(), output_tokens: z.number() });

export const Finding = z.object({
  rule_id: Id,
  rule_title: z.string(),
  status: FindingStatus,
  flag: z.boolean(),
  evidence: z.array(Evidence),
  matched: z.enum(["standard", "fallback", "unacceptable", "none"]).optional(),
  matched_fallback_index: z.number().int().optional(),
  explanation: z.string().max(2000),
  suggestion: Suggestion.optional(),
  verification: z.enum(["ok", "evidence_mismatch", "retry_exhausted"]),
  model: z.string(),
  usage: Usage,
  cost_usd: z.number(),
});
export type Finding = z.infer<typeof Finding>;

export const Gap = z.object({
  id: Id,
  kind: z.enum(["uncovered_clause", "existing_edit"]),
  evidence: z.array(Evidence),
  reason: z.string().max(1000),
  suggestion: Suggestion.optional(),
  severity: z.enum(["high", "medium", "low"]),
});
export type Gap = z.infer<typeof Gap>;

export const ReviewStatus = z.enum([
  "planned",
  "running",
  "verifying",
  "done",
  "failed",
  "cancelled",
]);
export type ReviewStatus = z.infer<typeof ReviewStatus>;
export const ReviewWarning = z.enum([
  "over_100_pages",
  "pdf_no_redlines",
  "existing_tracked_changes",
  "partial_coverage",
]);

export const ReviewSummary = z.object({
  acceptable: z.number().int(),
  needs_review: z.number().int(),
  not_acceptable: z.number().int(),
  not_found: z.number().int(),
  gaps: z.number().int(),
});
export type ReviewSummary = z.infer<typeof ReviewSummary>;

export const Customisation = z.object({
  party: z.string(),
  paper: Paper,
  mode: ReviewMode,
  scope: z.union([z.literal("all"), z.array(Id)]),
  jurisdiction: z.string().optional(),
});
export type Customisation = z.infer<typeof Customisation>;

export const Review = z.object({
  id: Id,
  run_id: Id,
  playbook_id: Id,
  playbook_version_id: Id,
  playbook_name: z.string(),
  document_id: Id,
  document_version_id: Id,
  document_name: z.string(),
  customisation: Customisation,
  surface: z.enum(["web", "word"]),
  status: ReviewStatus,
  clause_map_size: z.number().int(),
  excluded_regions: z.record(z.string(), z.number().int()),
  results: z.array(Finding),
  gaps: z.array(Gap),
  summary: ReviewSummary,
  warnings: z.array(ReviewWarning),
  usage: Usage.extend({ cost_usd: z.number(), models: z.array(z.string()) }),
  started_at: z.string(),
  finished_at: z.string().nullable(),
});
export type Review = z.infer<typeof Review>;

export const ApplyRequest = z.object({
  with_comment: z.boolean().default(false),
  alternate_id: Id.optional(),
  surface: z.enum(["web", "word"]),
  // Word only: what the pane saw before applying, so the server can detect drift.
  observed: z.object({ paragraph_index: z.number().int(), para_hash: z.string() }).optional(),
});
export type ApplyRequest = z.input<typeof ApplyRequest>;

export const ApplyResult = z.object({
  suggestion_id: Id,
  status: z.enum(["applied", "anchor_failed"]),
  /** Fragment for insertOoxml in Word: one w:p with w:del/w:ins runs. */
  ooxml: z.string().optional(),
  anchor: Anchor,
  comment_text: z.string().optional(),
  search_text: z.string().optional(),
  replace_mode: z.enum(["paragraph", "range"]),
});
export type ApplyResult = z.infer<typeof ApplyResult>;

export const ApplyAllResult = z.object({
  applied: z.array(Id),
  failed: z.array(z.object({ sid: Id, code: z.string() })),
});

export const ReviseRequest = z.object({ instruction: z.string().trim().min(1).max(2000) });
export const DismissRequest = z.object({ reason: z.string().max(1000).optional() });
export const ExportRequest = z.object({ format: z.enum(["docx", "xlsx"]) });
export const RedlineRequest = z.object({ include_pending: z.boolean().default(true) });

// SSE events on /runs/{run_id}/events for a review run (§5.3).
export const ReviewEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("review.planned"),
    clause_map_size: z.number().int(),
    rules_in_scope: z.number().int(),
    excluded_regions: z.record(z.string(), z.number().int()),
    warnings: z.array(ReviewWarning),
  }),
  z.object({ type: z.literal("review.rule_started"), rule_id: Id }),
  z.object({
    type: z.literal("review.rule_finished"),
    rule_id: Id,
    status: FindingStatus,
    has_suggestion: z.boolean(),
  }),
  z.object({
    type: z.literal("review.gap_pass_started"),
    uncovered_count: z.number().int(),
    existing_edits: z.number().int(),
  }),
  z.object({ type: z.literal("review.gap_pass_finished"), gap_count: z.number().int() }),
  z.object({
    type: z.literal("review.done"),
    summary: ReviewSummary,
    usage: Usage.extend({ cost_usd: z.number() }),
  }),
  z.object({ type: z.literal("run.failed"), code: z.string(), message: z.string() }),
  z.object({ type: z.literal("run.cancelled") }),
]);
export type ReviewEvent = z.infer<typeof ReviewEvent>;

// ---------- anchors ----------

/** Paragraph text as hashed: NFKC, whitespace runs collapsed, ends trimmed. */
export const normaliseParagraph = (text: string) =>
  text.normalize("NFKC").replace(/\s+/g, " ").trim();

/** sha256 hex of the normalised paragraph; the pane and the server must agree byte for byte. */
export async function paraHash(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(normaliseParagraph(text));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Pages for the warning: the host's count when known, else a character estimate. */
export const estimatePages = (chars: number, pageCount?: number | null) =>
  pageCount ?? Math.ceil(chars / PLAYBOOK_LIMITS.chars_per_page);
