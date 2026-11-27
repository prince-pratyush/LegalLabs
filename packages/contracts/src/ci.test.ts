import { describe, expect, it } from "vitest";
import {
  CiAgentCreate,
  CiAgentPatch,
  CiThresholds,
  ciAssignmentOrder,
  ciStatus,
  ciSummary,
} from "./index.js";

const ID = "01890000-0000-7000-8000-000000000001";
const GROUP = "01890000-0000-7000-8000-000000000002";
const OTHER = "01890000-0000-7000-8000-000000000003";

const finding = (status: string, flag = false, title = "Rule") => ({
  status: status as "acceptable",
  flag,
  rule_title: title,
});
const review = (
  results: ReturnType<typeof finding>[],
  gaps: { severity: "high" | "medium" | "low" }[] = [],
  warnings: "partial_coverage"[] = [],
) => ({ results, gaps, warnings });
const defaults = CiThresholds.parse({});

describe("ciStatus", () => {
  const ok = finding("acceptable");
  const bad = finding("not_acceptable");

  it.each([
    ["all acceptable", review([ok, ok]), "aligned"],
    ["one flagged rule not acceptable", review([ok, finding("not_acceptable", true)]), "deviates"],
    ["one non-flag rule not acceptable", review([ok, bad]), "needs_review"],
    ["two rules not acceptable", review([bad, bad]), "deviates"],
    ["a rule needing review", review([ok, finding("needs_review")]), "needs_review"],
    ["a high gap", review([ok], [{ severity: "high" }]), "deviates"],
    ["a low gap", review([ok], [{ severity: "low" }]), "needs_review"],
    ["a missing clause", review([ok, finding("not_found")]), "needs_review"],
    ["no rules checked", review([]), "needs_review"],
    ["partial coverage", review([ok], [], ["partial_coverage"]), "needs_review"],
    ["partial coverage and two bad", review([bad, bad], [], ["partial_coverage"]), "deviates"],
  ])("%s", (_name, input, expected) => {
    expect(ciStatus(input, defaults)).toBe(expected);
  });

  it("follows the agent's thresholds", () => {
    const loose = CiThresholds.parse({
      deviates_min_not_acceptable: 3,
      flag_rule_deviates: false,
      high_gap_deviates: false,
    });
    expect(ciStatus(review([bad, finding("not_acceptable", true)]), loose)).toBe("needs_review");
    expect(ciStatus(review([ok], [{ severity: "high" }]), loose)).toBe("needs_review");
    expect(ciStatus(review([bad, bad, bad]), loose)).toBe("deviates");
  });
});

describe("ciSummary", () => {
  it("names the deviating rules in at most three sentences", () => {
    const text = ciSummary(
      review(
        [
          finding("not_acceptable", true, "Liability cap"),
          finding("not_acceptable", false, "Payment terms"),
          finding("needs_review", false, "Term"),
          finding("not_found", false, "Audit"),
        ],
        [{ severity: "low" }],
        ["partial_coverage"],
      ),
    );
    expect(text).toContain("Liability cap, Payment terms");
    expect(text).toContain("Term, Audit");
    expect(text.match(/\.(\s|$)/g)?.length).toBeLessThanOrEqual(3);
  });

  it("says when nothing deviates", () => {
    expect(ciSummary(review([finding("acceptable")]))).toBe("No deviations from the playbook.");
  });

  it("stays within 1000 characters", () => {
    const many = Array.from({ length: 80 }, (_, i) =>
      finding("not_acceptable", false, `Rule ${i} ${"x".repeat(60)}`),
    );
    expect(ciSummary(review(many)).length).toBeLessThanOrEqual(1000);
  });
});

describe("ciAssignmentOrder", () => {
  const rules = [
    { kind: "round_robin" as const, group_id: GROUP },
    {
      kind: "field" as const,
      field: "governing_law" as const,
      cases: [{ op: "in" as const, value: ["DE", "FR"], assignee: { group_id: OTHER } }],
    },
    {
      kind: "field" as const,
      field: "contract_value" as const,
      cases: [{ op: "gt" as const, value: 100000, assignee: { user_id: OTHER } }],
    },
    { kind: "fixed" as const, user_id: ID },
  ];

  it("puts fixed before field matches before round robin", () => {
    expect(ciAssignmentOrder(rules, { governing_law: "de", contract_value: 200000 })).toEqual([
      { user_id: ID },
      { group_id: OTHER },
      { user_id: OTHER },
      { group_id: GROUP },
    ]);
  });

  it("skips cases that don't match or have no value", () => {
    expect(ciAssignmentOrder(rules, { contract_value: 5 })).toEqual([
      { user_id: ID },
      { group_id: GROUP },
    ]);
  });

  it("takes the first matching case of a rule, with eq and lt", () => {
    const rule = {
      kind: "field" as const,
      field: "contract_type" as const,
      cases: [
        { op: "eq" as const, value: "msa", assignee: { user_id: ID } },
        { op: "eq" as const, value: "MSA", assignee: { user_id: OTHER } },
      ],
    };
    expect(ciAssignmentOrder([rule], { contract_type: "MSA" })).toEqual([{ user_id: ID }]);
    const small = {
      kind: "field" as const,
      field: "contract_value" as const,
      cases: [{ op: "lt" as const, value: 10, assignee: { user_id: ID } }],
    };
    expect(ciAssignmentOrder([small], { contract_value: 5 })).toEqual([{ user_id: ID }]);
  });
});

describe("CiAgentCreate", () => {
  const body = {
    name: "MSA intake",
    contract_type: "MSA",
    playbook_id: ID,
    party: "Acme",
    assignment: [{ kind: "round_robin", group_id: GROUP }],
  };

  it("fills the defaults", () => {
    const parsed = CiAgentCreate.parse(body);
    expect(parsed.paper).toBe("theirs");
    expect(parsed.thresholds).toEqual({
      deviates_min_not_acceptable: 2,
      flag_rule_deviates: true,
      high_gap_deviates: true,
    });
  });

  it.each([
    ["no assignment rule", { ...body, assignment: [] }],
    ["an unknown key", { ...body, status: "live" }],
    ["a blank name", { ...body, name: "  " }],
    [
      "a value that doesn't fit the operator",
      {
        ...body,
        assignment: [
          {
            kind: "field",
            field: "contract_value",
            cases: [{ op: "gt", value: "much", assignee: { user_id: ID } }],
          },
        ],
      },
    ],
    [
      "an assignee that is both a person and a group",
      {
        ...body,
        assignment: [
          {
            kind: "field",
            field: "governing_law",
            cases: [{ op: "eq", value: "DE", assignee: { user_id: ID, group_id: GROUP } }],
          },
        ],
      },
    ],
  ])("refuses %s", (_name, input) => {
    expect(CiAgentCreate.safeParse(input).success).toBe(false);
  });

  it("patches only what is sent", () => {
    expect(CiAgentPatch.parse({ name: "New" })).toEqual({ name: "New" });
    expect(CiAgentPatch.safeParse({}).success).toBe(false);
  });
});
