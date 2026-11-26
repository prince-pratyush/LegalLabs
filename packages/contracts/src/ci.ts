import { z } from "zod";
import { Id } from "./id.js";
import { type Finding, type Gap, Paper, type ReviewWarning, Text } from "./playbook.js";

// Contract review agents and the queue of contracts they review. The status and assignment
// rules live here so the API and the web app agree on them.

export const CI_LIMITS = {
  assignment_rules: 20,
  cases: 50,
  summary_chars: 1000,
  page_size: 50,
} as const;

const Assignee = z.union([z.object({ user_id: Id }).strict(), z.object({ group_id: Id }).strict()]);
export type CiAssignee = z.infer<typeof Assignee>;

const Name = (max: number) => Text(max).trim().min(1);

export const CiField = z.enum([
  "governing_law",
  "counterparty_region",
  "contract_value",
  "contract_type",
]);
export type CiField = z.infer<typeof CiField>;

const Case = z.discriminatedUnion("op", [
  z.object({ op: z.literal("eq"), value: z.union([Name(200), z.number()]), assignee: Assignee }),
  z.object({
    op: z.literal("in"),
    value: z
      .array(z.union([Name(200), z.number()]))
      .min(1)
      .max(100),
    assignee: Assignee,
  }),
  z.object({ op: z.literal("gt"), value: z.number(), assignee: Assignee }),
  z.object({ op: z.literal("lt"), value: z.number(), assignee: Assignee }),
]);

export const AssignmentRule = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("fixed"), user_id: Id }).strict(),
  z.object({ kind: z.literal("round_robin"), group_id: Id }).strict(),
  z
    .object({
      kind: z.literal("field"),
      field: CiField,
      cases: z.array(Case).min(1).max(CI_LIMITS.cases),
    })
    .strict(),
]);
export type AssignmentRule = z.infer<typeof AssignmentRule>;

export const CiThresholds = z
  .object({
    deviates_min_not_acceptable: z.number().int().min(1).max(200).default(2),
    flag_rule_deviates: z.boolean().default(true),
    high_gap_deviates: z.boolean().default(true),
  })
  .strict();
export type CiThresholds = z.infer<typeof CiThresholds>;

const agentShape = {
  name: Name(200),
  contract_type: Name(100),
  playbook_id: Id,
  /** The side the review reads the contract for. */
  party: Name(200),
  paper: Paper,
  assignment: z.array(AssignmentRule).min(1).max(CI_LIMITS.assignment_rules),
  thresholds: CiThresholds,
};

export const CiAgentCreate = z
  .object({
    ...agentShape,
    paper: Paper.default("theirs"),
    thresholds: CiThresholds.prefault({}),
  })
  .strict();
export type CiAgentCreate = z.input<typeof CiAgentCreate>;

export const CiAgentPatch = z
  .object(agentShape)
  .partial()
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, { error: "EMPTY" });
export type CiAgentPatch = z.input<typeof CiAgentPatch>;

export const CiAgentStatus = z.enum(["draft", "live", "paused"]);
export type CiAgentStatus = z.infer<typeof CiAgentStatus>;

export const CiAgent = z.object({
  id: Id,
  ...agentShape,
  status: CiAgentStatus,
  created_at: z.string(),
  updated_at: z.string(),
});
export type CiAgent = z.infer<typeof CiAgent>;

/** What a rule can match on, given when the contract is submitted. */
export const CiFields = z
  .object({
    governing_law: Name(100),
    counterparty_region: Name(100),
    contract_value: z.number().min(0),
  })
  .partial()
  .strict();
export type CiFields = z.infer<typeof CiFields>;

export const CiReviewCreate = z
  .object({
    agent_id: Id,
    document_version_id: Id,
    counterparty: Name(200).optional(),
    fields: CiFields.optional(),
  })
  .strict();
export type CiReviewCreate = z.input<typeof CiReviewCreate>;

export const CiAssignRequest = z.object({ assignee_id: Id }).strict();
export const CiStatusRequest = z.object({ status: z.enum(["done", "queued"]) }).strict();

/** What the playbook review concluded; kept after the contract is marked done. */
export const CiResult = z.enum(["aligned", "needs_review", "deviates"]);
export type CiResult = z.infer<typeof CiResult>;

export const CiReviewStatus = z.enum(["queued", "running", ...CiResult.options, "done", "failed"]);
export type CiReviewStatus = z.infer<typeof CiReviewStatus>;

export const CiReview = z.object({
  id: Id,
  agent_id: Id,
  agent_name: z.string(),
  document_id: Id,
  document_version_id: Id,
  document_name: z.string(),
  playbook_review_id: Id.nullable(),
  run_id: Id.nullable(),
  status: CiReviewStatus,
  result: CiResult.nullable(),
  summary: z.string().max(CI_LIMITS.summary_chars).nullable(),
  /** Why a failed review failed, as a code. */
  failure: z.string().nullable(),
  assignee_id: Id.nullable(),
  assignee_name: z.string().nullable(),
  counterparty: z.string().nullable(),
  source: z.object({ kind: z.string(), external_ref: z.string().optional() }),
  created_at: z.string(),
  updated_at: z.string(),
  done_at: z.string().nullable(),
});
export type CiReview = z.infer<typeof CiReview>;

/** The queue's counters, as the caller sees the queue. */
export const CiDashboard = z.object({
  since_last_visit: z.number().int().min(0),
  ready_to_review: z.number().int().min(0),
  assigned_to_me: z.number().int().min(0),
  /** Server time of this count; the next visit asks for what finished after it. */
  as_of: z.string(),
});
export type CiDashboard = z.infer<typeof CiDashboard>;

export interface CiOutcome {
  results: readonly Pick<Finding, "status" | "flag" | "rule_title">[];
  gaps: readonly Pick<Gap, "severity">[];
  warnings: readonly z.infer<typeof ReviewWarning>[];
}

const partial = (r: CiOutcome) => r.warnings.includes("partial_coverage");

export function ciStatus(review: CiOutcome, thresholds: CiThresholds): CiResult {
  const bad = review.results.filter((f) => f.status === "not_acceptable");
  if (
    (thresholds.flag_rule_deviates && bad.some((f) => f.flag)) ||
    bad.length >= thresholds.deviates_min_not_acceptable ||
    (thresholds.high_gap_deviates && review.gaps.some((g) => g.severity === "high"))
  ) {
    return "deviates";
  }
  // Aligned means every rule was checked and met: a missing clause or an unread part is not that.
  const met = review.results.length > 0 && review.results.every((f) => f.status === "acceptable");
  return met && review.gaps.length === 0 && !partial(review) ? "aligned" : "needs_review";
}

const clip = (text: string, n: number) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

/** At most three sentences, built from the findings so it never says more than they do. */
export function ciSummary(review: CiOutcome): string {
  const titles = (...statuses: Finding["status"][]) =>
    review.results
      .filter((f) => statuses.includes(f.status))
      .map((f) => f.rule_title)
      .join(", ");
  const bad = titles("not_acceptable");
  const check = titles("needs_review", "not_found");
  const gaps = review.gaps.length;
  const notes = [
    gaps ? `${gaps} ${gaps === 1 ? "issue" : "issues"} outside the playbook` : "",
    partial(review) ? "only part of the document was read" : "",
  ].filter(Boolean);
  const other = notes.join("; ");
  const sentences = [
    bad ? `Not acceptable: ${clip(bad, 450)}.` : "",
    check ? `To check or missing: ${clip(check, 350)}.` : "",
    other ? `${other.charAt(0).toUpperCase()}${other.slice(1)}.` : "",
  ].filter(Boolean);
  return sentences.join(" ") || "No deviations from the playbook.";
}

type Values = CiFields & { contract_type?: string };

const same = (a: string | number, b: string | number) =>
  String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

function matches(c: z.infer<typeof Case>, value: string | number): boolean {
  if (c.op === "eq") return same(c.value, value);
  if (c.op === "in") return c.value.some((v) => same(v, value));
  if (typeof value !== "number") return false;
  return c.op === "gt" ? value > c.value : value < c.value;
}

const RANK = { fixed: 0, field: 1, round_robin: 2 } as const;

/**
 * Who to try, first to last: fixed owners, then field matches, then round-robin groups. The
 * caller takes the first that can open the contract, and falls back to the agent's owner.
 */
export function ciAssignmentOrder(rules: readonly AssignmentRule[], values: Values): CiAssignee[] {
  return [...rules]
    .sort((a, b) => RANK[a.kind] - RANK[b.kind])
    .flatMap((rule): CiAssignee[] => {
      if (rule.kind === "fixed") return [{ user_id: rule.user_id }];
      if (rule.kind === "round_robin") return [{ group_id: rule.group_id }];
      const value = values[rule.field];
      if (value === undefined) return [];
      const found = rule.cases.find((c) => matches(c, value));
      return found ? [found.assignee] : [];
    });
}
