import type { Review, Suggestion } from "@legallabs/contracts";
import { describe, expect, it } from "vitest";
import { cardsFromReview, inDocumentOrder } from "./card.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const hash = "a".repeat(64);

const suggestion = (n: number, paragraph: number, extra: Partial<Suggestion> = {}): Suggestion => ({
  id: id(n),
  rule_id: id(100 + n),
  anchor: { paragraph_index: paragraph, char_from: 0, char_to: 1, para_hash: hash },
  kind: "replace",
  before: "x",
  after: "y",
  justification: "why",
  status: "pending",
  ...extra,
});

const finding = (
  n: number,
  status: Review["results"][number]["status"],
  paragraph: number,
  flag = false,
) => ({
  rule_id: id(100 + n),
  rule_title: `Rule ${n}`,
  status,
  flag,
  evidence: [],
  explanation: "",
  suggestion: suggestion(n, paragraph),
  verification: "ok" as const,
  model: "local",
  usage: { input_tokens: 0, output_tokens: 0 },
  cost_usd: 0,
});

const review = (results: Review["results"], gaps: Review["gaps"] = []) =>
  ({ results, gaps }) as unknown as Review;

describe("cardsFromReview", () => {
  it("orders not acceptable, needs review, then gaps, flagged first, then by paragraph", () => {
    const cards = cardsFromReview(
      review(
        [
          finding(1, "needs_review", 1),
          finding(2, "not_acceptable", 9),
          finding(3, "not_acceptable", 4),
          finding(4, "not_acceptable", 12, true),
          finding(5, "acceptable", 2),
        ],
        [
          {
            id: id(50),
            kind: "uncovered_clause",
            evidence: [],
            reason: "r",
            severity: "high",
            suggestion: suggestion(50, 0),
          },
        ],
      ),
    );
    expect(cards.map((c) => c.title)).toEqual([
      "Rule 4",
      "Rule 3",
      "Rule 2",
      "Rule 1",
      "Outside the playbook",
    ]);
  });

  it("leaves out superseded edits and turns insertions into empty-before cards", () => {
    const superseded = { ...finding(1, "not_acceptable", 1) };
    superseded.suggestion = suggestion(1, 1, { status: "superseded" });
    const missing = { ...finding(2, "not_found", 3) };
    missing.suggestion = suggestion(2, 3, { kind: "insert_after", before: "ignored" });
    const cards = cardsFromReview(review([superseded, missing]));
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ before: "", after: "y", ruleId: id(102) });
  });

  it("applies in document order", () => {
    const cards = cardsFromReview(
      review([finding(1, "needs_review", 1), finding(2, "not_acceptable", 9)]),
    );
    expect(inDocumentOrder(cards).map((c) => c.anchor.paragraph_index)).toEqual([1, 9]);
  });
});
