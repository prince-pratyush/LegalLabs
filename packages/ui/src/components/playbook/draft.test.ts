import { RuleList } from "@legallabs/contracts";
import { describe, expect, it } from "vitest";
import { blankRule, checkDraft, isClean, moveRule, toEditable, toRuleInput } from "./draft.js";
import { sampleRules } from "./fixtures.js";

describe("playbook drafts", () => {
  it("round-trip a stored rule into what the API accepts", () => {
    const inputs = sampleRules.map((r) => toRuleInput(toEditable(r)));
    expect(RuleList.safeParse(inputs).success).toBe(true);
    expect(inputs[1]?.condition).toEqual({ kind: "jurisdiction", in: ["US", "UK"] });
    expect(inputs[1]).not.toHaveProperty("unacceptable");
    expect(inputs[0]).not.toHaveProperty("provenance");
  });

  it("drop empty fallbacks and keep a non-jurisdiction condition as it was", () => {
    const rule = toEditable({
      title: "Term",
      standard_position: "Two years.",
      fallbacks: ["One year.", "  "],
      condition: { kind: "paper", equals: "theirs" },
    });
    rule.jurisdictions = "US";
    expect(toRuleInput(rule)).toMatchObject({
      fallbacks: ["One year."],
      condition: { kind: "paper", equals: "theirs" },
    });
  });

  it("move rules up and down within bounds", () => {
    expect(moveRule(["a", "b", "c"], 0, 1)).toEqual(["b", "a", "c"]);
    expect(moveRule(["a", "b", "c"], 2, 1)).toEqual(["a", "c", "b"]);
    expect(moveRule(["a", "b"], 0, -1)).toEqual(["a", "b"]);
  });

  it("name what stops a save", () => {
    const a = { ...blankRule(), title: "Term", standard_position: "x" };
    const b = { ...blankRule(), title: " term ", standard_position: "", jurisdictions: "us, xx1" };
    const problems = checkDraft({ name: "", contract_type: "NDA", guidance: "", rules: [a, b] });
    expect(problems.playbook).toEqual(["Give the playbook a name."]);
    expect(problems.rules[b.key]).toEqual({
      title: "Another rule has this title.",
      standard_position: "Add the standard position.",
      jurisdictions: "Use codes like US, UK or US-CA, not XX1.",
    });
    expect(isClean(problems)).toBe(false);
    const ok = checkDraft({ name: "N", contract_type: "NDA", guidance: "", rules: [a] });
    expect(isClean(ok)).toBe(true);
  });
});
