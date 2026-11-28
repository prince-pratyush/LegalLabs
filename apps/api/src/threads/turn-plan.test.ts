import { describe, expect, it } from "vitest";
import { parseTurnPlan, planCommand, wantsPlan, withoutPlanCommand } from "./turn-plan.js";

describe("when a turn is planned first", () => {
  it("reads the /plan command and takes it off the question", () => {
    expect(planCommand("/plan draft a memo")).toBe(true);
    expect(planCommand("  /Plan\ndraft")).toBe(true);
    expect(planCommand("/planning draft")).toBe(false);
    expect(planCommand("write a /plan")).toBe(false);
    expect(
      withoutPlanCommand([
        { type: "text", text: "/plan draft a memo on " },
        { type: "mention", ref_type: "document", ref_id: "d", label: "MSA" },
      ]),
    ).toMatchObject([{ type: "text", text: "draft a memo on " }, { type: "mention" }]);
  });

  it("plans a short request that lists more than three tasks", () => {
    expect(wantsPlan("Do this:\n1. read\n2. compare\n3. list\n4. draft")).toBe(true);
    expect(wantsPlan("- read\n- compare\n- list\n- draft")).toBe(true);
    expect(wantsPlan("1. read\n2. compare\n3. draft")).toBe(false);
    expect(wantsPlan("What is the cap?")).toBe(false);
    // A pasted agreement is material, not a list of tasks.
    expect(wantsPlan(`Summarise:\n${"1. The Tenant pays rent monthly.\n".repeat(80)}`)).toBe(false);
  });
});

describe("the plan a model proposes", () => {
  const plan = {
    steps: ["Read the lease", "Draft"],
    question: { text: "Which party?", options: ["Landlord", "Tenant"], allow_text: true },
  };

  it("keeps only the known shape, bounded", () => {
    expect(parseTurnPlan(JSON.stringify(plan))).toEqual({
      steps: ["Read the lease", "Draft"],
      question: {
        text: "Which party?",
        options: [
          { id: "o1", label: "Landlord" },
          { id: "o2", label: "Tenant" },
        ],
        allow_text: true,
      },
    });
    expect(parseTurnPlan('```json\n{"steps":["a\\u202eb"]}\n```')).toEqual({
      steps: ["a b"],
      question: null,
    });
    for (const bad of [
      "I will read the lease.",
      JSON.stringify({ steps: [] }),
      JSON.stringify({ steps: Array(9).fill("a") }),
      JSON.stringify({ steps: ["x".repeat(201)] }),
      JSON.stringify({ steps: ["a"], run: "rm -rf" }),
      JSON.stringify({ steps: ["a"], question: { text: "q", options: Array(5).fill("o") } }),
      // A question nobody could answer.
      JSON.stringify({ steps: ["a"], question: { text: "q", options: [], allow_text: false } }),
    ]) {
      expect(parseTurnPlan(bad)).toBeNull();
    }
  });
});
