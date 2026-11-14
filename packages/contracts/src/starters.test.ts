import { describe, expect, it } from "vitest";
import { PlaybookPatch, RuleList, STARTERS, StarterTemplate, starterPlaybook } from "./index.js";

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

  it("returns a copy so callers cannot mutate the shipped starter", () => {
    const copy = starterPlaybook(template);
    copy.rules.pop();
    expect(STARTERS[template].rules.length).toBe(copy.rules.length + 1);
  });
});

describe("jurisdiction conditions", () => {
  it("use only the jurisdictions the starters cover", () => {
    const used = Object.values(STARTERS).flatMap((s) =>
      s.rules.flatMap((r) => (r.condition?.kind === "jurisdiction" ? r.condition.in : [])),
    );
    expect(used.length).toBeGreaterThan(0);
    for (const code of used) expect(["US", "EU", "UK", "AU"]).toContain(code);
  });
});
