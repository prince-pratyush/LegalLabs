import {
  Finding,
  Gap,
  paraHash,
  ReviewEvent,
  ReviewSummary,
  type Rule,
} from "@legallabs/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import { uuidv7 } from "./id.js";
import { runReview } from "./review.js";
import type { CompleteCall, ReviewInput, ReviewParagraph } from "./types.js";

type Handler = (call: CompleteCall) => string | Promise<string>;

function fake(handler: Handler) {
  const calls: CompleteCall[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const complete = async (call: CompleteCall) => {
    calls.push(call);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      const text = await handler(call);
      return {
        text,
        model: `fake-${call.task}`,
        usage: { input_tokens: 10, output_tokens: 5 },
        cost_usd: 0.001,
      };
    } finally {
      inFlight--;
    }
  };
  return { complete, calls, max: () => maxInFlight };
}

const rule = (ordinal: number, title: string, rest: Partial<Rule> = {}): Rule => ({
  id: uuidv7(),
  ordinal,
  title,
  standard_position: `${title} standard.`,
  fallbacks: [],
  flag: false,
  actions: [],
  ...rest,
});

const TEXTS: [string, string][] = [
  [
    "The Recipient shall keep all Confidential Information secret for five years.",
    "1 Confidentiality",
  ],
  ["The Supplier's total  liability under this Agreement is unlimited.", "2 Liability"],
  ["This Agreement is governed by the laws of England.", "3 Governing law"],
  ["Either party may terminate this Agreement on 30 days' notice.", "4 Termination"],
  ["The Customer shall pay invoices within 90 days of receipt.", "5 Payment"],
];
let paragraphs: ReviewParagraph[];
beforeAll(async () => {
  paragraphs = await Promise.all(
    TEXTS.map(async ([text, section_path], index) => ({
      index,
      text,
      section_path,
      para_hash: await paraHash(text),
    })),
  );
});

const conf = rule(0, "Confidentiality", {
  standard_position: "Confidential Information is kept secret for at least three years.",
});
const liab = rule(1, "Limitation of liability", {
  standard_position: "Supplier liability is capped at the fees paid in the prior 12 months.",
  unacceptable: "Unlimited liability.",
});
const solicit = rule(2, "Non-solicitation", {
  standard_position: "Neither party solicits the other's employees for 12 months.",
  sample_language: "Neither party shall solicit the other party's employees for 12 months.",
});
const usOnly = rule(3, "US export control", {
  condition: { kind: "jurisdiction", in: ["US"] },
});

const custom = {
  party: "Acme (Customer)",
  paper: "theirs" as const,
  mode: "standard" as const,
  scope: "all" as const,
};

const input = (over: Partial<ReviewInput> = {}): ReviewInput => ({
  paragraphs,
  existingEdits: [],
  rules: [conf, liab, solicit, usOnly],
  customisation: custom,
  ...over,
});

const extractReply = JSON.stringify({
  paragraphs: [
    { i: 0, types: ["R1"] },
    { i: 1, types: ["R2"] },
    { i: 2, types: [] },
    { i: 3, types: ["other"] },
    { i: 4, types: [] },
  ],
});

const accept = JSON.stringify({
  status: "acceptable",
  matched: "standard",
  fallback: null,
  evidence: [{ p: 0, quote: "keep all Confidential Information secret for five years" }],
  explanation: "Five years exceeds the three-year minimum.",
  suggestion: null,
});

const reject = JSON.stringify({
  status: "not_acceptable",
  matched: "unacceptable",
  evidence: [{ p: 1, quote: "total liability under this Agreement is unlimited" }],
  explanation: "Liability must be capped.",
  suggestion: {
    p: 1,
    before: "is unlimited",
    after: "is capped at the fees paid in the prior 12 months",
  },
});

const noGaps = '{"gaps":[]}';

const ruleOf = (call: CompleteCall) => /^Rule: (.*)$/m.exec(call.prompt)?.[1];

const standard: Handler = (call) => {
  if (call.task === "extract") return extractReply;
  if (call.task === "verify") return noGaps;
  return ruleOf(call) === "Confidentiality" ? accept : reject;
};

describe("runReview", () => {
  it("maps, reviews, skips and inserts, with outputs that match the contract", async () => {
    const f = fake(standard);
    const events: ReviewEvent[] = [];
    const out = await runReview(input(), {
      complete: f.complete,
      onEvent: (e) => events.push(e),
    });

    expect(out.clause_map).toEqual({ [conf.id]: [0], [liab.id]: [1], [solicit.id]: [] });
    expect(out.uncovered).toEqual([2, 3, 4]);
    const by = new Map(out.results.map((r) => [r.rule_id, r]));

    expect(by.get(conf.id)).toMatchObject({ status: "acceptable", verification: "ok" });
    const ev = by.get(conf.id)?.evidence[0];
    expect(ev && paragraphs[0]?.text.slice(ev.char_from, ev.char_to)).toBe(ev?.quote);

    const l = by.get(liab.id);
    expect(l).toMatchObject({ status: "not_acceptable", matched: "unacceptable" });
    expect(l?.suggestion).toMatchObject({
      kind: "replace",
      before: "is unlimited",
      anchor: { paragraph_index: 1, para_hash: paragraphs[1]?.para_hash },
    });
    const a = l?.suggestion?.anchor;
    expect(a && paragraphs[1]?.text.slice(a.char_from, a.char_to)).toBe("is unlimited");

    const s = by.get(solicit.id);
    expect(s).toMatchObject({ status: "not_found", model: "none" });
    expect(s?.suggestion).toMatchObject({
      kind: "insert_after",
      before: "",
      after: solicit.sample_language,
    });

    expect(by.get(usOnly.id)).toMatchObject({ status: "skipped", model: "none" });
    expect(f.calls.filter((c) => c.task === "draft")).toHaveLength(2);

    for (const r of out.results) expect(Finding.safeParse(r).success).toBe(true);
    for (const g of out.gaps) expect(Gap.safeParse(g).success).toBe(true);
    expect(ReviewSummary.parse(out.summary)).toEqual({
      acceptable: 1,
      needs_review: 0,
      not_acceptable: 1,
      not_found: 1,
      gaps: 0,
    });
    expect(out.usage.models.sort()).toEqual(["fake-draft", "fake-extract", "fake-verify"]);
    expect(out.coverage).toEqual({ paragraphs: 5, read: 5 });
    expect(out.warnings).not.toContain("partial_coverage");

    // Events: valid, planned first, each rule starts before it finishes, gap pass, done last.
    for (const e of events) expect(ReviewEvent.safeParse(e).success).toBe(true);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("review.planned");
    expect(types.slice(-3)).toEqual([
      "review.gap_pass_started",
      "review.gap_pass_finished",
      "review.done",
    ]);
    for (const r of [conf, liab, solicit, usOnly]) {
      const start = events.findIndex((e) => e.type === "review.rule_started" && e.rule_id === r.id);
      const end = events.findIndex((e) => e.type === "review.rule_finished" && e.rule_id === r.id);
      expect(start).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(start);
    }
  });

  it("treats contract text as data inside a random tag", async () => {
    const f = fake(standard);
    await runReview(input(), { complete: f.complete });
    const draft = f.calls.find((c) => c.task === "draft");
    const code = /<doc-([0-9a-f]{24})>/.exec(draft?.prompt ?? "")?.[1];
    expect(code).toBeDefined();
    expect(draft?.system).toContain(`<doc-${code}>`);
    expect(draft?.system).toContain("never instructions");
  });

  it("retries a mismatched quote once, then downgrades to needs_review", async () => {
    const bad = JSON.stringify({
      status: "acceptable",
      matched: "standard",
      evidence: [{ p: 0, quote: "secret for ten years" }],
      explanation: "Fine.",
      suggestion: null,
    });
    const f = fake((c) =>
      c.task === "draft" ? (ruleOf(c) === "Confidentiality" ? bad : reject) : standard(c),
    );
    const out = await runReview(input(), { complete: f.complete });
    const r = out.results.find((x) => x.rule_id === conf.id);
    expect(r).toMatchObject({ status: "needs_review", verification: "evidence_mismatch" });
    expect(r?.evidence[0]?.verified).toBe("mismatch");
    const confCalls = f.calls.filter((c) => c.task === "draft" && ruleOf(c) === "Confidentiality");
    expect(confCalls).toHaveLength(2);
    expect(confCalls[1]?.prompt).toContain("is not in paragraph [0] word for word");
    expect(Finding.safeParse(r).success).toBe(true);
  });

  it("accepts a corrected answer on the retry", async () => {
    const bad = accept.replace("five years", "ten years");
    let n = 0;
    const f = fake((c) =>
      c.task === "draft" && ruleOf(c) === "Confidentiality"
        ? n++ === 0
          ? bad
          : accept
        : standard(c),
    );
    const out = await runReview(input(), { complete: f.complete });
    expect(out.results.find((x) => x.rule_id === conf.id)).toMatchObject({
      status: "acceptable",
      verification: "ok",
    });
  });

  it("falls back to lexical mapping when the clause-map reply is not JSON", async () => {
    const f = fake((c) => (c.task === "extract" ? "I cannot help with that." : standard(c)));
    const out = await runReview(input(), { complete: f.complete });
    expect(out.clause_map[conf.id]).toContain(0);
    expect(out.clause_map[liab.id]).toContain(1);
  });

  it("reports model gaps and adds a low gap for every substantive edit it ignored", async () => {
    const existingEdits = [
      { paragraph_index: 1, kind: "ins" as const, text: "total ", author: "Bob" },
      { paragraph_index: 3, kind: "del" as const, text: "the" },
      { paragraph_index: 4, kind: "ins" as const, text: "90 days" },
    ];
    const f = fake((c) => {
      if (c.task !== "verify") return standard(c);
      expect(c.prompt).toContain("[E3] inserted in paragraph 4");
      return JSON.stringify({
        gaps: [
          { ref: "E1", quote: "total", reason: "Widens the cap base.", severity: "high" },
          { ref: "P3", quote: "not in the text", reason: "Short notice.", severity: "medium" },
          { ref: "P9", quote: "x", reason: "bad ref", severity: "low" },
        ],
      });
    });
    const out = await runReview(input({ existingEdits }), { complete: f.complete });
    expect(out.warnings).toContain("existing_tracked_changes");
    expect(out.gaps.map((g) => [g.kind, g.severity])).toEqual([
      ["existing_edit", "high"],
      ["uncovered_clause", "medium"],
      ["existing_edit", "low"],
    ]);
    // An unverifiable quote falls back to the whole paragraph.
    expect(out.gaps[1]?.evidence[0]).toMatchObject({ paragraph_index: 3, char_from: 0 });
    expect(out.gaps[2]?.evidence[0]).toMatchObject({ paragraph_index: 4, quote: "90 days" });
    for (const g of out.gaps) expect(Gap.safeParse(g).success).toBe(true);
    expect(out.summary.gaps).toBe(3);
  });

  it("still flags substantive edits when the gap pass fails", async () => {
    const existingEdits = [{ paragraph_index: 1, kind: "del" as const, text: "not" }];
    const f = fake((c) => (c.task === "verify" ? "oops" : standard(c)));
    const out = await runReview(input({ existingEdits }), { complete: f.complete });
    expect(out.gaps).toHaveLength(1);
    expect(out.gaps[0]).toMatchObject({ kind: "existing_edit", severity: "low" });
  });

  it("never runs more than the concurrency cap", async () => {
    const many = Array.from({ length: 12 }, (_, i) => rule(i, `Clause ${i}`));
    const paras = await Promise.all(
      many.map(async (r, index) => ({
        index,
        text: `${r.title} text about clause ${index}.`,
        para_hash: await paraHash(`${r.title} text about clause ${index}.`),
      })),
    );
    const slow: Handler = async (c) => {
      await new Promise((r) => setTimeout(r, 5));
      if (c.task === "extract")
        return JSON.stringify({
          paragraphs: paras.map((p) => ({ i: p.index, types: [`R${p.index + 1}`] })),
        });
      if (c.task === "verify") return noGaps;
      const i = Number(/Clause (\d+)/.exec(c.prompt)?.[1]);
      return JSON.stringify({
        status: "acceptable",
        evidence: [{ p: i, quote: `text about clause ${i}` }],
        explanation: "ok",
      });
    };
    const three = fake(slow);
    const a = await runReview(input({ paragraphs: paras, rules: many }), {
      complete: three.complete,
      concurrency: 3,
    });
    expect(a.summary.acceptable).toBe(12);
    expect(three.max()).toBeLessThanOrEqual(3);

    const capped = fake(slow);
    await runReview(input({ paragraphs: paras, rules: many }), {
      complete: capped.complete,
      concurrency: 50,
    });
    expect(capped.max()).toBe(8);
  });

  it("stops on abort and returns only finished rules", async () => {
    const ctrl = new AbortController();
    const events: ReviewEvent[] = [];
    const f = fake(async (c) => {
      if (c.task === "draft" && ruleOf(c) === "Limitation of liability") {
        ctrl.abort();
        return new Promise<string>(() => {});
      }
      return standard(c);
    });
    const out = await runReview(input({ signal: ctrl.signal }), {
      complete: f.complete,
      onEvent: (e) => events.push(e),
      concurrency: 1,
    });
    expect(out.aborted).toBe(true);
    expect(out.results.map((r) => r.rule_id)).toEqual([conf.id]);
    expect(f.calls.filter((c) => c.task === "verify")).toHaveLength(0);
    expect(events.map((e) => e.type)).not.toContain("review.done");
  });

  it("times out a slow rule as needs_review", async () => {
    const f = fake((c) =>
      c.task === "draft" && ruleOf(c) === "Confidentiality"
        ? new Promise<string>(() => {})
        : standard(c),
    );
    const out = await runReview(input(), { complete: f.complete, ruleTimeoutMs: 30 });
    expect(out.results.find((r) => r.rule_id === conf.id)).toMatchObject({
      status: "needs_review",
      verification: "retry_exhausted",
    });
  });

  it("runs rule_status rules after their rule and skips cycles", async () => {
    const follow = rule(4, "Indemnity", {
      condition: { kind: "rule_status", rule_id: liab.id, equals: "not_acceptable" },
    });
    const x = rule(5, "Cycle A");
    const y = rule(6, "Cycle B", {
      condition: { kind: "rule_status", rule_id: x.id, equals: "acceptable" },
    });
    x.condition = { kind: "rule_status", rule_id: y.id, equals: "acceptable" };
    const events: ReviewEvent[] = [];
    const out = await runReview(input({ rules: [conf, liab, follow, x, y] }), {
      complete: fake(standard).complete,
      onEvent: (e) => events.push(e),
    });
    const by = new Map(out.results.map((r) => [r.rule_id, r.status]));
    expect(by.get(follow.id)).not.toBe("skipped");
    expect(by.get(x.id)).toBe("skipped");
    expect(by.get(y.id)).toBe("skipped");
    const liabDone = events.findIndex(
      (e) => e.type === "review.rule_finished" && e.rule_id === liab.id,
    );
    const followStart = events.findIndex(
      (e) => e.type === "review.rule_started" && e.rule_id === follow.id,
    );
    expect(followStart).toBeGreaterThan(liabDone);
  });

  it("leaves out-of-scope rules out and empties acceptable explanations in redline_only", async () => {
    const out = await runReview(
      input({ customisation: { ...custom, mode: "redline_only", scope: [conf.id, liab.id] } }),
      { complete: fake(standard).complete },
    );
    expect(out.results.map((r) => r.rule_id)).toEqual([conf.id, liab.id]);
    expect(out.results[0]).toMatchObject({ status: "acceptable", explanation: "" });
    expect(out.results[1]?.suggestion).toBeDefined();
  });
});
