import type {
  Finding,
  FindingStatus,
  Gap,
  ReviewSummary,
  Suggestion,
  SuggestionStatus,
} from "@legallabs/contracts";

/** One card in the rail: a rule's finding or a gap no rule covers. */
export type ReviewItem =
  | { kind: "rule"; id: string; finding: Finding }
  | { kind: "gap"; id: string; gap: Gap };

export const ruleItem = (finding: Finding): ReviewItem => ({
  kind: "rule",
  id: `rule:${finding.rule_id}`,
  finding,
});
export const gapItem = (gap: Gap): ReviewItem => ({ kind: "gap", id: `gap:${gap.id}`, gap });

export const suggestionOf = (item: ReviewItem): Suggestion | undefined =>
  item.kind === "rule" ? item.finding.suggestion : item.gap.suggestion;

const LAST = Number.POSITIVE_INFINITY;

/** Where an item sits in the document: its first evidence paragraph, else its edit's. */
export function firstParagraph(item: ReviewItem): number {
  const evidence = item.kind === "rule" ? item.finding.evidence : item.gap.evidence;
  const at = evidence.map((e) => e.paragraph_index);
  const anchor = suggestionOf(item)?.anchor.paragraph_index;
  if (at.length > 0) return Math.min(...at);
  return anchor ?? LAST;
}

// Array.prototype.sort is stable, so ties keep playbook order.
const byDocument = (items: ReviewItem[]) =>
  [...items].sort((a, b) => firstParagraph(a) - firstParagraph(b));
const flagged = (item: ReviewItem) => item.kind === "rule" && item.finding.flag;
const flagFirst = (items: ReviewItem[]) =>
  [...items].sort((a, b) => Number(flagged(b)) - Number(flagged(a)));

/**
 * Rules view: document order of the first evidence paragraph; missing clauses last,
 * then skipped ones, both in playbook order (`results` arrive in that order).
 */
export function rulesView(results: readonly Finding[]): ReviewItem[] {
  const items = results.map(ruleItem);
  const late = new Set<FindingStatus>(["not_found", "skipped"]);
  const found = items.filter((i) => i.kind === "rule" && !late.has(i.finding.status));
  const missing = items.filter((i) => i.kind === "rule" && i.finding.status === "not_found");
  const skipped = items.filter((i) => i.kind === "rule" && i.finding.status === "skipped");
  return [...byDocument(found), ...missing, ...skipped];
}

export type SuggestionGroup = { key: string; title: string; items: ReviewItem[] };

/**
 * Suggestions view: edits only, not acceptable then needs review then missing clauses,
 * then gaps. Flagged rules lead their group; otherwise document order.
 */
export function suggestionsView(
  results: readonly Finding[],
  gaps: readonly Gap[],
): SuggestionGroup[] {
  const withEdit = results.filter((f) => f.suggestion && f.suggestion.status !== "superseded");
  const of = (status: FindingStatus) =>
    flagFirst(byDocument(withEdit.filter((f) => f.status === status).map(ruleItem)));
  const groups: SuggestionGroup[] = [
    { key: "not_acceptable", title: "Not acceptable", items: of("not_acceptable") },
    { key: "needs_review", title: "Needs review", items: of("needs_review") },
    { key: "not_found", title: "Missing clauses", items: of("not_found") },
    { key: "gaps", title: "Outside the playbook", items: byDocument(gaps.map(gapItem)) },
  ];
  return groups.filter((g) => g.items.length > 0);
}

/** Gaps in document order, for the Rules view's closing section. */
export const gapsView = (gaps: readonly Gap[]): ReviewItem[] => byDocument(gaps.map(gapItem));

/** Pending edits in document order, as Apply all works through them. */
export function pendingSuggestions(results: readonly Finding[], gaps: readonly Gap[]) {
  return byDocument([...results.map(ruleItem), ...gaps.map(gapItem)]).flatMap((item) => {
    const s = suggestionOf(item);
    return s?.status === "pending" ? [s] : [];
  });
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "21 acceptable · 7 needs review · 4 not acceptable · 3 outside rules" */
export function summaryLine(summary: ReviewSummary): string {
  const parts = [
    `${summary.acceptable} acceptable`,
    `${summary.needs_review} needs review`,
    `${summary.not_acceptable} not acceptable`,
  ];
  if (summary.not_found > 0) parts.push(`${summary.not_found} missing`);
  parts.push(`${plural(summary.gaps, "outside rule", "outside rules")}`);
  return parts.join(" · ");
}

export const FINDING_LABEL: Record<FindingStatus, string> = {
  acceptable: "Acceptable",
  needs_review: "Needs review",
  not_acceptable: "Not acceptable",
  not_found: "Clause missing",
  skipped: "Skipped",
};

export const SUGGESTION_LABEL: Record<SuggestionStatus, string> = {
  pending: "Suggested",
  applied: "Applied",
  dismissed: "Dismissed",
  superseded: "Replaced by a revision",
  anchor_failed: "Clause changed since review",
};

export const SEVERITY_LABEL: Record<Gap["severity"], string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
};

/** Per-rule progress as the run's events arrive. */
export type RuleProgress = "queued" | "running" | FindingStatus;
export type ProgressState = {
  rules: Record<string, RuleProgress>;
  gapPass: "queued" | "running" | "done";
  gapCount: number | null;
  finished: "done" | "failed" | "cancelled" | null;
  error: string | null;
};

export const startProgress = (ruleIds: readonly string[]): ProgressState => ({
  rules: Object.fromEntries(ruleIds.map((id) => [id, "queued" as const])),
  gapPass: "queued",
  gapCount: null,
  finished: null,
  error: null,
});

/** Loose on purpose: the stream carries run events too, and unknown ones are ignored. */
export type ProgressEvent = { type: string; [key: string]: unknown };

export function applyEvent(state: ProgressState, event: ProgressEvent): ProgressState {
  switch (event.type) {
    case "review.rule_started":
      return { ...state, rules: { ...state.rules, [String(event.rule_id)]: "running" } };
    case "review.rule_finished":
      return {
        ...state,
        rules: { ...state.rules, [String(event.rule_id)]: event.status as FindingStatus },
      };
    case "review.gap_pass_started":
      return { ...state, gapPass: "running" };
    case "review.gap_pass_finished":
      return { ...state, gapPass: "done", gapCount: Number(event.gap_count) };
    case "review.done":
      return { ...state, finished: "done" };
    case "status": {
      const s = event.status;
      return s === "done" || s === "failed" || s === "cancelled"
        ? { ...state, finished: s }
        : state;
    }
    case "error":
      return event.retryable
        ? state
        : { ...state, finished: "failed", error: String(event.message ?? "The review failed.") };
    default:
      return state;
  }
}

/** Rules that have an answer, for "Rule 14 of 32". */
export const rulesFinished = (state: ProgressState) =>
  Object.values(state.rules).filter((s) => s !== "queued" && s !== "running").length;

/** "1 m 40 s", "45 s" */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} m ${s % 60} s`;
}
