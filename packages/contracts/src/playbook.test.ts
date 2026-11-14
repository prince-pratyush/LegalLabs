import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ApplyRequest,
  estimatePages,
  normaliseParagraph,
  PLAYBOOK_LIMITS,
  PlaybookCreate,
  paraHash,
  ReviewEvent,
  ReviewRequest,
  RuleInput,
  RuleList,
} from "./index.js";

const ID = "01933b8a-7c2e-7d4a-9f10-3c5e8b2a1d4f";
const rule = (title: string) => ({ title, standard_position: "Mutual." });

describe("RuleList", () => {
  it("fills defaults so a starter rule can be short", () => {
    expect(RuleInput.parse(rule("Term"))).toMatchObject({
      fallbacks: [],
      actions: [],
      flag: false,
    });
  });

  it("refuses two rules with the same title in any case", () => {
    const out = RuleList.safeParse([rule("Term"), rule(" term ")]);
    expect(out.success).toBe(false);
    expect(out.error?.issues[0]?.message).toBe("DUPLICATE_RULE_TITLE");
  });

  it("refuses the 201st rule with RULE_LIMIT", () => {
    const rules = Array.from({ length: PLAYBOOK_LIMITS.rules + 1 }, (_, i) => rule(`R${i}`));
    expect(RuleList.safeParse(rules).error?.issues[0]?.message).toBe("RULE_LIMIT");
    expect(RuleList.safeParse(rules.slice(1)).success).toBe(true);
  });

  it("caps fallbacks at five", () => {
    const six = { ...rule("Cap"), fallbacks: ["a", "b", "c", "d", "e", "f"] };
    expect(RuleInput.safeParse(six).success).toBe(false);
  });
});

describe("PlaybookCreate", () => {
  it("knows the starter templates", () => {
    const base = { name: "NDA", contract_type: "NDA" };
    expect(
      PlaybookCreate.safeParse({ ...base, source: { kind: "starter", template: "nda" } }).success,
    ).toBe(true);
    expect(
      PlaybookCreate.safeParse({ ...base, source: { kind: "starter", template: "lease" } }).success,
    ).toBe(false);
  });
});

describe("ReviewRequest", () => {
  it("defaults to their paper, standard mode, every rule", () => {
    expect(
      ReviewRequest.parse({ document_version_id: ID, party: "Acme", surface: "web" }),
    ).toMatchObject({
      paper: "theirs",
      mode: "standard",
      scope: "all",
    });
  });

  it("refuses an empty rule scope, which would read as 'nothing'", () => {
    expect(
      ReviewRequest.safeParse({ document_version_id: ID, party: "A", surface: "web", scope: [] })
        .success,
    ).toBe(false);
  });

  it("applies without a comment unless asked", () => {
    expect(ApplyRequest.parse({ surface: "word" }).with_comment).toBe(false);
  });
});

describe("ReviewEvent", () => {
  it("parses a finished rule", () => {
    const event = {
      type: "review.rule_finished",
      rule_id: ID,
      status: "not_acceptable",
      has_suggestion: true,
    };
    expect(ReviewEvent.parse(event)).toEqual(event);
  });
});

describe("paraHash", () => {
  it("ignores spacing differences Word introduces", () => {
    expect(normaliseParagraph("  The Supplier \n shall ")).toBe("The Supplier shall");
  });

  it("is sha256 hex of the normalised text", async () => {
    const expected = createHash("sha256").update("The Supplier shall").digest("hex");
    expect(await paraHash(" The  Supplier shall")).toBe(expected);
  });
});

describe("estimatePages", () => {
  it("prefers the real page count", () => {
    expect(estimatePages(9_000, 7)).toBe(7);
    expect(estimatePages(9_001)).toBe(4);
  });
});
