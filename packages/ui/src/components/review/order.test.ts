import type { Finding } from "@legallabs/contracts";
import { describe, expect, it } from "vitest";
import { sampleFindings, sampleGaps } from "./fixtures.js";
import {
  applyEvent,
  elapsed,
  firstParagraph,
  pendingSuggestions,
  ruleItem,
  rulesFinished,
  rulesView,
  startProgress,
  suggestionsView,
  summaryLine,
} from "./order.js";

const titles = (items: { kind: string; id: string }[]) => items.map((i) => i.id);

describe("ordering", () => {
  it("finds an item's first paragraph from evidence, else its edit", () => {
    const [liability, , , missing, skipped] = sampleFindings as Finding[];
    expect(firstParagraph(ruleItem(liability as Finding))).toBe(3);
    expect(firstParagraph(ruleItem(missing as Finding))).toBe(5);
    expect(firstParagraph(ruleItem(skipped as Finding))).toBe(Number.POSITIVE_INFINITY);
  });

  it("orders the rules view by document, keeping missing rules in playbook order", () => {
    const [a, b, c, d, e] = sampleFindings.map((f) => `rule:${f.rule_id}`);
    expect(titles(rulesView(sampleFindings))).toEqual([b, a, c, d, e]);
  });

  it("puts flagged rules first within a status group", () => {
    const [liability, confidentiality] = sampleFindings as Finding[];
    const late = { ...(liability as Finding), evidence: [], flag: true };
    const early = { ...(confidentiality as Finding), status: "not_acceptable" as const };
    const groups = suggestionsView([early, late], []);
    expect(groups[0]?.items.map((i) => i.id)).toEqual([
      `rule:${late.rule_id}`,
      `rule:${early.rule_id}`,
    ]);
  });

  it("leaves acceptable findings and superseded edits out of the suggestions view", () => {
    const groups = suggestionsView(sampleFindings, sampleGaps);
    expect(groups.map((g) => g.key)).toEqual([
      "not_acceptable",
      "needs_review",
      "not_found",
      "gaps",
    ]);
  });

  it("lists pending edits in document order", () => {
    expect(
      pendingSuggestions(sampleFindings, sampleGaps).map((s) => s.anchor.paragraph_index),
    ).toEqual([3, 5]);
  });

  it("writes the summary line", () => {
    expect(
      summaryLine({ acceptable: 21, needs_review: 7, not_acceptable: 4, not_found: 0, gaps: 3 }),
    ).toBe("21 acceptable · 7 needs review · 4 not acceptable · 3 outside rules");
    expect(
      summaryLine({ acceptable: 1, needs_review: 0, not_acceptable: 0, not_found: 2, gaps: 1 }),
    ).toBe("1 acceptable · 0 needs review · 0 not acceptable · 2 missing · 1 outside rule");
  });
});

describe("progress", () => {
  it("follows rule and gap events to the end of the run", () => {
    let s = startProgress(["r1", "r2"]);
    s = applyEvent(s, { type: "review.rule_started", rule_id: "r1" });
    expect(s.rules.r1).toBe("running");
    s = applyEvent(s, { type: "review.rule_finished", rule_id: "r1", status: "acceptable" });
    s = applyEvent(s, { type: "review.gap_pass_started" });
    s = applyEvent(s, { type: "review.gap_pass_finished", gap_count: 2 });
    s = applyEvent(s, { type: "token", delta: "ignored" });
    expect(rulesFinished(s)).toBe(1);
    expect([s.gapPass, s.gapCount, s.finished]).toEqual(["done", 2, null]);
    expect(applyEvent(s, { type: "status", status: "cancelled" }).finished).toBe("cancelled");
    expect(applyEvent(s, { type: "error", message: "x", retryable: true }).finished).toBe(null);
    expect(applyEvent(s, { type: "error", message: "No model.", retryable: false })).toMatchObject({
      finished: "failed",
      error: "No model.",
    });
  });

  it("formats elapsed time", () => {
    expect(elapsed(45_400)).toBe("45 s");
    expect(elapsed(100_000)).toBe("1 m 40 s");
  });
});
