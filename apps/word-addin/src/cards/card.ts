import type { FindingStatus, Review, Suggestion } from "@legallabs/contracts";
import type { Anchor } from "../edits/anchor.js";

export type CardKind = "not_acceptable" | "needs_review" | "gap" | "proofread";
export type CardState = "pending" | "applied" | "dismissed" | "anchor_failed";

/** One proposed edit, from a playbook review or a proofread, shown and applied alike. */
export type Card = {
  id: string;
  kind: CardKind;
  title: string;
  anchor: Anchor;
  before: string;
  after: string;
  justification: string;
  state: CardState;
  flag: boolean;
  /** The playbook rule behind it, so one rule can be re-run; null for proofreading. */
  ruleId: string | null;
};

const ORDER: Record<CardKind, number> = {
  not_acceptable: 0,
  needs_review: 1,
  gap: 2,
  proofread: 3,
};

const stateOf = (s: Suggestion): CardState =>
  s.status === "applied" || s.status === "dismissed" || s.status === "anchor_failed"
    ? s.status
    : "pending";

const fromSuggestion = (s: Suggestion, kind: CardKind, title: string, flag: boolean): Card => ({
  id: s.id,
  kind,
  title,
  anchor: { paragraph_index: s.anchor.paragraph_index, para_hash: s.anchor.para_hash },
  // An insertion adds a paragraph after the anchor, so there is nothing to replace.
  before: s.kind === "insert_after" ? "" : s.before,
  after: s.after,
  justification: s.justification,
  state: stateOf(s),
  flag,
  ruleId: s.rule_id,
});

const KINDS: Partial<Record<FindingStatus, CardKind>> = {
  not_acceptable: "not_acceptable",
  needs_review: "needs_review",
  // A missing clause carries an insertion, which reads as not acceptable.
  not_found: "not_acceptable",
};

/**
 * The Suggestions view (spec §4.8): not acceptable, then needs review, then gaps;
 * flagged rules first within a group, then document order. Superseded edits are gone.
 */
export function cardsFromReview(review: Review): Card[] {
  const cards: Card[] = [];
  for (const finding of review.results) {
    const kind = KINDS[finding.status];
    const s = finding.suggestion;
    if (!kind || !s || s.status === "superseded") continue;
    cards.push(fromSuggestion(s, kind, finding.rule_title, finding.flag));
  }
  for (const gap of review.gaps) {
    const s = gap.suggestion;
    if (!s || s.status === "superseded") continue;
    cards.push(fromSuggestion(s, "gap", "Outside the playbook", gap.severity === "high"));
  }
  return sortCards(cards);
}

export const sortCards = (cards: Card[]) =>
  cards.sort(
    (a, b) =>
      ORDER[a.kind] - ORDER[b.kind] ||
      Number(b.flag) - Number(a.flag) ||
      a.anchor.paragraph_index - b.anchor.paragraph_index,
  );

/** Document order, for Apply all: later edits never shift earlier anchors. */
export const inDocumentOrder = (cards: readonly Card[]) =>
  [...cards].sort((a, b) => a.anchor.paragraph_index - b.anchor.paragraph_index);

export const KIND_LABEL: Record<CardKind, string> = {
  not_acceptable: "Not acceptable",
  needs_review: "Needs review",
  gap: "Outside the playbook",
  proofread: "Proofread",
};
