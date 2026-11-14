import { Id, type Rule } from "@legallabs/contracts";
import { describe, expect, it } from "vitest";
import { evaluateCondition } from "./condition.js";
import { uuidv7 } from "./id.js";
import { parseJsonObject } from "./json.js";
import { lexicalMap } from "./lexical.js";
import { verifyQuote } from "./verify.js";

describe("verifyQuote", () => {
  it("returns raw offsets past collapsed spaces and invisible characters", () => {
    const raw = "The  Supplier​ shall\tpay   within 30 days.";
    const m = verifyQuote(raw, "shall pay within 30 days");
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    expect(raw.slice(m.char_from, m.char_to)).toBe(m.text);
    expect(m.text).toBe("shall\tpay   within 30 days");
  });

  it("forgives case, curly quotes, dashes and wrapping punctuation", () => {
    const raw = "The “Services” — as defined — are provided AS IS.";
    const m = verifyQuote(raw, '..."services" - as defined - are provided as is"');
    expect(m.ok).toBe(true);
    // Wrapping quote marks are stripped from the model's quote, so the span starts inside.
    if (m.ok) expect(m.text).toBe("Services” — as defined — are provided AS IS");
  });

  it("rejects quotes that are not in the paragraph or too short", () => {
    expect(verifyQuote("Liability is capped.", "liability is unlimited").ok).toBe(false);
    expect(verifyQuote("Liability is capped.", "is").ok).toBe(false);
  });
});

describe("parseJsonObject", () => {
  it("skips think tags, fences and prose", () => {
    expect(parseJsonObject('<think>{"no":1}</think>Sure!\n```json\n{"a":{"b":"}"}}\n```')).toEqual({
      a: { b: "}" },
    });
  });

  it("returns undefined when there is no object", () => {
    expect(parseJsonObject("no json here")).toBeUndefined();
    expect(parseJsonObject('{"cut": ')).toBeUndefined();
  });
});

const custom = {
  party: "Acme (Customer)",
  paper: "theirs" as const,
  mode: "standard" as const,
  scope: "all" as const,
};

describe("evaluateCondition", () => {
  const ctx = { customisation: custom, statuses: new Map() };
  it("compares paper", () => {
    expect(evaluateCondition({ kind: "paper", equals: "theirs" }, ctx)).toBe(true);
    expect(evaluateCondition({ kind: "paper", equals: "ours" }, ctx)).toBe(false);
  });

  it("reads a role from the party label and holds when none is named", () => {
    expect(evaluateCondition({ kind: "party_role", equals: "customer" }, ctx)).toBe(true);
    expect(evaluateCondition({ kind: "party_role", equals: "supplier" }, ctx)).toBe(false);
    const anon = { customisation: { ...custom, party: "Acme Ltd" }, statuses: new Map() };
    expect(evaluateCondition({ kind: "party_role", equals: "supplier" }, anon)).toBe(true);
  });

  it("skips jurisdiction rules when the jurisdiction is unknown", () => {
    expect(evaluateCondition({ kind: "jurisdiction", in: ["US"] }, ctx)).toBe(false);
    const ca = { customisation: { ...custom, jurisdiction: "US-CA" }, statuses: new Map() };
    expect(evaluateCondition({ kind: "jurisdiction", in: ["US"] }, ca)).toBe(true);
    expect(evaluateCondition({ kind: "jurisdiction", in: ["EU", "UK"] }, ca)).toBe(false);
  });

  it("waits on rule_status until the other rule finishes", () => {
    const id = uuidv7();
    const cond = { kind: "rule_status" as const, rule_id: id, equals: "not_found" as const };
    const statuses = new Map<string, "pending" | "not_found">([[id, "pending"]]);
    expect(evaluateCondition(cond, { customisation: custom, statuses })).toBe("pending");
    statuses.set(id, "not_found");
    expect(evaluateCondition(cond, { customisation: custom, statuses })).toBe(true);
    expect(evaluateCondition(cond, { customisation: custom, statuses: new Map() })).toBe(false);
  });
});

describe("lexicalMap", () => {
  const rule = (title: string, standard_position: string, ordinal: number): Rule => ({
    id: uuidv7(),
    ordinal,
    title,
    standard_position,
    fallbacks: [],
    flag: false,
    actions: [],
  });
  const p = (index: number, text: string, section_path?: string) => ({
    index,
    text,
    para_hash: "0".repeat(64),
    ...(section_path ? { section_path } : {}),
  });

  it("maps paragraphs by title, position and heading, leaving the rest uncovered", () => {
    const liab = rule("Limitation of liability", "Liability is capped at the fees paid.", 0);
    const law = rule("Governing law", "English law governs.", 1);
    const solicit = rule("Non-solicitation", "No poaching of staff.", 2);
    const paras = [
      p(0, "The Supplier's total liability shall not exceed the fees paid.", "7 Liability"),
      p(1, "This agreement is governed by English law.", "12 Governing law"),
      p(2, "Notices must be in writing."),
      p(3, "Header text", undefined),
    ];
    paras[3] = { ...paras[3], excluded: true } as (typeof paras)[number];
    const { clause_map, uncovered } = lexicalMap(paras, [liab, law, solicit]);
    expect(clause_map[liab.id]).toEqual([0]);
    expect(clause_map[law.id]).toEqual([1]);
    expect(clause_map[solicit.id]).toEqual([]);
    expect(uncovered).toEqual([2]);
  });
});

describe("uuidv7", () => {
  it("is a valid v7 id that sorts by time", () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_001);
    expect(Id.safeParse(a).success).toBe(true);
    expect(a < b).toBe(true);
  });
});
