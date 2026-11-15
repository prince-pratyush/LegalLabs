import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ApplyRequest,
  ApplyResult,
  Condition,
  estimatePages,
  isTerminal,
  normaliseParagraph,
  PLAYBOOK_LIMITS,
  PlaybookCreate,
  paraHash,
  ReviewEvent,
  ReviewRequest,
  ReviewStreamEvent,
  RuleInput,
  RuleList,
  type RunEvent,
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

describe("review fixes", () => {
  const req = { document_version_id: ID, party: "Acme", surface: "web" };

  it("refuses a misspelt key instead of widening scope to every rule", () => {
    expect(ReviewRequest.safeParse({ ...req, scop: [ID] }).success).toBe(false);
  });

  it("won't let a client claim verified provenance", () => {
    const claimed = {
      ...rule("Term"),
      provenance: { document_id: ID, quote: "x", verified: true },
    };
    expect(RuleInput.safeParse(claimed).success).toBe(false);
  });

  it("keeps rule ids unique so conditions point at one rule", () => {
    const out = RuleList.safeParse([
      { ...rule("A"), id: ID },
      { ...rule("B"), id: ID },
    ]);
    expect(out.error?.issues[0]?.message).toBe("DUPLICATE_RULE_ID");
  });

  it("checks jurisdiction codes", () => {
    const ok = { kind: "jurisdiction", in: ["AU", "US-CA"] };
    expect(Condition.safeParse(ok).success).toBe(true);
    expect(Condition.safeParse({ kind: "jurisdiction", in: ["australia"] }).success).toBe(false);
  });

  it("refuses NUL in clause text", () => {
    expect(RuleInput.safeParse({ ...rule("T"), guidance: "a\u0000b" }).success).toBe(false);
  });

  it("has an apply mode for inserted clauses", () => {
    expect(ApplyResult.shape.replace_mode.options).toContain("insert_after");
  });

  it("ends a review stream on the shared run events", () => {
    const done = ReviewStreamEvent.parse({ type: "status", seq: 3, status: "cancelled" });
    expect(isTerminal(done as RunEvent)).toBe(true);
  });
});

describe("paraHash parity", () => {
  it("drops invisible characters and maps every space kind the same way", async () => {
    const plain = await paraHash("Fee is payable");
    for (const variant of ["Fee is payable", "﻿Fee is pay­able", "Fee​ is　payable"]) {
      expect(await paraHash(variant)).toBe(plain);
    }
  });

  it("pins a golden vector for other implementations", async () => {
    expect(await paraHash("1.1  The Customer may terminate.")).toBe(
      createHash("sha256").update("1.1 The Customer may terminate.").digest("hex"),
    );
  });
});
