import {
  Finding,
  Gap,
  paraHash,
  ReviewEvent,
  ReviewSummary,
  type Rule,
} from "@legallabs/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import { EXTRACT_CHUNK_CHARS } from "./clause-map.js";
import { uuidv7 } from "./id.js";
import { draftPrompt } from "./prompts.js";
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  ["Each party manages its own employees.", "6 Personnel"],
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
  standard_position: "No poaching of staff.",
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

/** Answers a clause-map prompt from a title → paragraphs table, in the sparse shape. */
const extractFor = (table: Record<string, number[]>) => (call: CompleteCall) => {
  const out: Record<string, number[]> = {};
  for (const m of call.prompt.matchAll(/^(R\d+): (.+?) \(/gm)) {
    const idxs = table[m[2] ?? ""];
    if (m[1] && idxs) out[m[1]] = idxs;
  }
  return JSON.stringify(out);
};
const extractReply = extractFor({ Confidentiality: [0], "Limitation of liability": [1] });

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
const tags = (text: string) => [...text.matchAll(/<doc-([0-9a-f]{24})>/g)].map((m) => m[1]);

const standard: Handler = (call) => {
  if (call.task === "extract") return extractReply(call);
  if (call.task === "verify") return noGaps;
  return ruleOf(call) === "Confidentiality" ? accept : reject;
};

describe("draftPrompt", () => {
  it("sets a whole-sentence scenario apart from what to do about it", () => {
    const actions = [{ scenario: "The cap has no floor.", instruction: "Counter." }];
    const prompt = draftPrompt(
      { rule: rule(0, "Cap", { actions }), paragraphs: [] } as unknown as Parameters<
        typeof draftPrompt
      >[0],
      "c0de",
    );
    expect(prompt).toContain("\nIf this applies: The cap has no floor. Then: Counter.\n");
  });
});

describe("runReview", () => {
  it("maps, reviews, skips and inserts, with outputs that match the contract", async () => {
    const f = fake(standard);
    const events: ReviewEvent[] = [];
    const out = await runReview(input(), {
      complete: f.complete,
      onEvent: (e) => events.push(e),
    });

    expect(out.clause_map).toEqual({ [conf.id]: [0], [liab.id]: [1], [solicit.id]: [] });
    expect(out.uncovered).toEqual([2, 3, 4, 5]);
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

    // Missing clause: inserted after the paragraph that shares its words.
    const s = by.get(solicit.id);
    expect(s).toMatchObject({ status: "not_found", model: "none" });
    expect(s?.suggestion).toMatchObject({
      kind: "insert_after",
      before: "",
      after: solicit.sample_language,
      anchor: { paragraph_index: 5 },
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
    expect(out.coverage).toEqual({ paragraphs: 6, read: 6 });
    expect(out.warnings).not.toContain("partial_coverage");

    // Events: valid, planned first, done last, each rule and the gap pass start before they end.
    for (const e of events) expect(ReviewEvent.safeParse(e).success).toBe(true);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("review.planned");
    expect(types.at(-1)).toBe("review.done");
    expect(types.indexOf("review.gap_pass_started")).toBeGreaterThan(0);
    expect(types.indexOf("review.gap_pass_finished")).toBeGreaterThan(
      types.indexOf("review.gap_pass_started"),
    );
    for (const r of [conf, liab, solicit, usOnly]) {
      const start = events.findIndex((e) => e.type === "review.rule_started" && e.rule_id === r.id);
      const end = events.findIndex((e) => e.type === "review.rule_finished" && e.rule_id === r.id);
      expect(start).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(start);
    }
  });

  it("reports usage per phase that adds up to the total", async () => {
    const out = await runReview(input(), { complete: fake(standard).complete });
    const { plan, rules, verify } = out.phases;
    expect(plan.models).toEqual(["fake-extract"]);
    expect(verify).toMatchObject({ calls: 1, models: ["fake-verify"] });
    expect(rules[liab.id]).toMatchObject({ calls: 1, input_tokens: 10, models: ["fake-draft"] });
    expect(rules[solicit.id]?.calls).toBe(0);
    const calls = plan.calls + verify.calls + Object.values(rules).reduce((s, u) => s + u.calls, 0);
    expect(out.usage.input_tokens).toBe(calls * 10);
    expect(out.usage.cost_usd).toBeCloseTo(calls * 0.001);
    expect(out.usage.models.sort()).toEqual(["fake-draft", "fake-extract", "fake-verify"]);
  });

  it("tags document text with a fresh code per call", async () => {
    const f = fake(standard);
    await runReview(input(), { complete: f.complete });
    const drafts = f.calls.filter((c) => c.task === "draft");
    const codes = drafts.map((c) => tags(c.prompt)[0]);
    expect(codes.every((c) => c !== undefined)).toBe(true);
    expect(new Set(codes).size).toBe(codes.length);
    for (const c of drafts) {
      expect(c.system).toContain("never instructions");
      expect(c.system).toBe(drafts[0]?.system);
    }
  });

  it("retries a mismatched quote once, with the old reply tagged, then downgrades", async () => {
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
    const retry = confCalls[1]?.prompt ?? "";
    expect(retry).toContain("is not in paragraph [0] word for word");
    const code = /Your previous reply, between <doc-([0-9a-f]{24})> tags/.exec(retry)?.[1];
    expect(retry).toContain(`<doc-${code}>\n${bad}\n</doc-${code}>`);
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

  it("rejects a status that contradicts its match", async () => {
    const odd = accept.replace('"matched":"standard"', '"matched":"unacceptable"');
    const f = fake((c) =>
      c.task === "draft" && ruleOf(c) === "Confidentiality" ? odd : standard(c),
    );
    const out = await runReview(input(), { complete: f.complete });
    expect(out.results.find((x) => x.rule_id === conf.id)).toMatchObject({
      status: "needs_review",
      verification: "evidence_mismatch",
    });
    const retry = f.calls.filter((c) => ruleOf(c) === "Confidentiality")[1]?.prompt;
    expect(retry).toContain('status "acceptable" cannot have matched "unacceptable"');
  });

  it("offers no insertion when the model finds mapped text is not the clause", async () => {
    const f = fake((c) =>
      c.task === "draft" && ruleOf(c) === "Limitation of liability"
        ? '{"status":"not_found","explanation":"About something else."}'
        : standard(c),
    );
    const withSample = { ...liab, sample_language: "Liability is capped at fees paid." };
    const out = await runReview(input({ rules: [conf, withSample] }), { complete: f.complete });
    const r = out.results.find((x) => x.rule_id === liab.id);
    expect(r).toMatchObject({ status: "not_found", explanation: "About something else." });
    expect(r?.suggestion).toBeUndefined();
  });

  it("offers no insertion when no paragraph relates to the missing clause", async () => {
    const lonely = rule(5, "Escrow", {
      standard_position: "Source code escrow with a named agent.",
      sample_language: "Source code shall be deposited with an escrow agent.",
    });
    const out = await runReview(input({ rules: [lonely] }), { complete: fake(standard).complete });
    expect(out.results[0]).toMatchObject({ status: "not_found" });
    expect(out.results[0]?.suggestion).toBeUndefined();
  });

  it("falls back to lexical mapping when the clause-map reply is not JSON", async () => {
    const f = fake((c) => (c.task === "extract" ? "I cannot help with that." : standard(c)));
    const out = await runReview(input(), { complete: f.complete });
    expect(out.clause_map[conf.id]).toContain(0);
    expect(out.clause_map[liab.id]).toContain(1);
  });

  it("keeps every clause-map call within its budget, batching a long rule list", async () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      rule(i, `Topic ${i} ${"x".repeat(40)}`, { standard_position: "Position text. ".repeat(20) }),
    );
    const f = fake((c) => (c.task === "extract" ? "{}" : c.task === "verify" ? noGaps : "{}"));
    await runReview(input({ rules: many }), { complete: f.complete, parallelism: 8 });
    const extracts = f.calls.filter((c) => c.task === "extract");
    expect(extracts.length).toBeGreaterThan(1);
    let listed = 0;
    for (const c of extracts) {
      expect(c.prompt.length).toBeLessThan(EXTRACT_CHUNK_CHARS + 1500);
      listed += c.prompt.match(/^R\d+: /gm)?.length ?? 0;
    }
    expect(listed).toBe(200);
  });

  it("maps a lexically confident rule without asking the model", async () => {
    const law = rule(4, "Governing law", {
      standard_position: "English law governs the agreement.",
    });
    const f = fake(standard);
    const out = await runReview(input({ rules: [law, solicit] }), { complete: f.complete });
    expect(out.clause_map[law.id]).toEqual([2]);
    for (const c of f.calls.filter((x) => x.task === "extract"))
      expect(c.prompt).not.toMatch(/^R\d+: Governing law/m);
  });

  it("gap-checks uncovered paragraphs against the rules that ran", async () => {
    // Mapped to paragraph 3, then skipped because liability is not acceptable.
    const follow = rule(4, "Termination rights", {
      condition: { kind: "rule_status", rule_id: liab.id, equals: "acceptable" },
    });
    const f = fake((c) =>
      c.task === "extract"
        ? extractFor({
            Confidentiality: [0],
            "Limitation of liability": [1],
            "Termination rights": [3],
          })(c)
        : standard(c),
    );
    const out = await runReview(input({ rules: [conf, liab, usOnly, follow] }), {
      complete: f.complete,
    });
    expect(out.results.find((r) => r.rule_id === follow.id)?.status).toBe("skipped");
    const gap = f.calls.find((c) => c.task === "verify")?.prompt ?? "";
    expect(gap).toContain("- Confidentiality:");
    expect(gap).not.toContain("US export control");
    expect(gap).toContain("[P2]");
    expect(gap).not.toContain("[P3]");
    // Paragraph 3 was mapped but never read, so coverage says so.
    expect(out.coverage).toEqual({ paragraphs: 6, read: 5 });
    expect(out.warnings).toContain("partial_coverage");
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

  it("never runs more calls than its parallelism, 2 by default and 8 at most", async () => {
    const many = Array.from({ length: 12 }, (_, i) => rule(i, `Clause ${i}`));
    const paras = await Promise.all(
      many.map(async (r, index) => ({
        index,
        text: `${r.title} text about clause ${index}.`,
        para_hash: await paraHash(`${r.title} text about clause ${index}.`),
      })),
    );
    const table = extractFor(Object.fromEntries(many.map((r, i) => [r.title, [i]])));
    const slow: Handler = async (c) => {
      await sleep(5);
      if (c.task === "extract") return table(c);
      if (c.task === "verify") return noGaps;
      const i = Number(/Rule: Clause (\d+)/.exec(c.prompt)?.[1]);
      return JSON.stringify({
        status: "acceptable",
        evidence: [{ p: i, quote: `text about clause ${i}` }],
        explanation: "ok",
      });
    };
    const run = async (parallelism?: number) => {
      const f = fake(slow);
      const out = await runReview(input({ paragraphs: paras, rules: many }), {
        complete: f.complete,
        ...(parallelism ? { parallelism } : {}),
      });
      expect(out.summary.acceptable).toBe(12);
      return f.max();
    };
    expect(await run()).toBe(2);
    expect(await run(3)).toBe(3);
    expect(await run(50)).toBe(8);
  });

  it("starts a rule's clock when its call starts, not while it queues", async () => {
    const f = fake(async (c) => {
      if (c.task === "verify") {
        await sleep(80);
        return noGaps;
      }
      await sleep(10);
      return standard(c);
    });
    const out = await runReview(input({ rules: [conf, liab] }), {
      complete: f.complete,
      parallelism: 1,
      ruleTimeoutMs: 60,
    });
    for (const r of out.results) expect(r.verification).toBe("ok");
  });

  it("stops on abort and returns only finished rules", async () => {
    const ctrl = new AbortController();
    const events: ReviewEvent[] = [];
    let callsAtAbort = 0;
    const f = fake(async (c) => {
      if (c.task === "draft" && ruleOf(c) === "Limitation of liability") {
        callsAtAbort = f.calls.length;
        ctrl.abort();
        return new Promise<string>(() => {});
      }
      return standard(c);
    });
    const out = await runReview(input({ signal: ctrl.signal }), {
      complete: f.complete,
      onEvent: (e) => events.push(e),
      parallelism: 1,
    });
    expect(out.aborted).toBe(true);
    expect(out.results.map((r) => r.rule_id)).toEqual([conf.id]);
    expect(f.calls).toHaveLength(callsAtAbort);
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

  it("leaves out-of-scope rules out and every explanation empty in redline_only", async () => {
    const f = fake(standard);
    const out = await runReview(
      input({
        customisation: { ...custom, mode: "redline_only", scope: [conf.id, liab.id, usOnly.id] },
      }),
      { complete: f.complete },
    );
    expect(out.results.map((r) => r.rule_id)).toEqual([conf.id, liab.id, usOnly.id]);
    for (const r of out.results) expect(r.explanation).toBe("");
    expect(out.results[1]?.suggestion?.justification).toBe("Liability must be capped.");
    expect(f.calls.find((c) => c.task === "draft")?.maxTokens).toBe(600);
  });
});
