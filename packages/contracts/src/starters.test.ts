import { describe, expect, it } from "vitest";
import {
  PlaybookPatch,
  RuleList,
  STARTERS,
  StarterPlaybook,
  StarterTemplate,
  starterPlaybook,
} from "./index.js";

describe.each(StarterTemplate.options)("%s starter", (template) => {
  const starter = STARTERS[template];

  it("parses as a playbook patch and a rule list", () => {
    expect(PlaybookPatch.safeParse(starter).success).toBe(true);
    expect(RuleList.safeParse(starter.rules).success).toBe(true);
  });

  it("gives every rule sample language, an unacceptable line and guidance", () => {
    for (const rule of starter.rules) {
      expect(rule.sample_language?.trim(), rule.title).toBeTruthy();
      expect(rule.unacceptable?.trim(), rule.title).toBeTruthy();
      expect(rule.guidance?.trim(), rule.title).toBeTruthy();
    }
  });

  it("gives every rule at least one fallback", () => {
    for (const rule of starter.rules) {
      expect(rule.fallbacks?.length ?? 0, rule.title).toBeGreaterThan(0);
    }
  });

  it("covers the expected number of clauses", () => {
    const [min, max] = template === "nda" ? [12, 16] : [18, 26];
    expect(starter.rules.length).toBeGreaterThanOrEqual(min);
    expect(starter.rules.length).toBeLessThanOrEqual(max);
  });

  it("flags the commercially sensitive rules", () => {
    expect(starter.rules.some((r) => r.flag)).toBe(true);
  });

  it("is frozen, while starterPlaybook returns a mutable copy", () => {
    expect(Object.isFrozen(starter.rules[0]?.fallbacks)).toBe(true);
    expect(() => (starter.rules as unknown[]).pop()).toThrow(TypeError);
    const copy = starterPlaybook(template);
    copy.rules.pop();
    expect(starter.rules.length).toBe(copy.rules.length + 1);
  });

  it("uses one placeholder style in sample language", () => {
    for (const rule of starter.rules) {
      for (const p of rule.sample_language?.match(/\[[^\]]*\]/g) ?? []) {
        expect(p, rule.title).toMatch(/^\[[A-Z][a-z]+\]$/);
      }
    }
  });
});

describe("StarterPlaybook", () => {
  it("refuses unknown keys and missing guidance", () => {
    const { guidance: _, ...noGuidance } = starterPlaybook("nda");
    expect(StarterPlaybook.safeParse(noGuidance).success).toBe(false);
    expect(StarterPlaybook.safeParse({ ...starterPlaybook("nda"), extra: 1 }).success).toBe(false);
  });

  it("refuses server-only rule fields", () => {
    const starter = starterPlaybook("nda");
    const [first, ...rest] = starter.rules;
    const withProvenance = { ...starter, rules: [{ ...first, provenance: null }, ...rest] };
    expect(StarterPlaybook.safeParse(withProvenance).success).toBe(false);
  });
});

describe("jurisdiction conditions", () => {
  it("use only the jurisdictions the starters cover", () => {
    const used = Object.values(STARTERS).flatMap((s) =>
      s.rules.flatMap((r) => (r.condition?.kind === "jurisdiction" ? r.condition.in : [])),
    );
    for (const code of used) expect(["US", "EU", "UK", "AU"]).toContain(code);
  });
});
