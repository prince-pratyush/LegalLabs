import type {
  Customisation,
  Evidence,
  Finding,
  FindingStatus,
  Rule,
  Suggestion,
} from "@legallabs/contracts";
import { describeCondition } from "./condition.js";
import { type Ctx, clip } from "./context.js";
import { parseJsonObject } from "./json.js";
import { mostRelated } from "./lexical.js";
import { type Budget, CallTimeout } from "./model.js";
import { type DraftContext, DraftReply, draftPrompt, draftSystem, retryPrompt } from "./prompts.js";
import type { PhaseUsage, ReviewParagraph } from "./types.js";
import { verifyQuote } from "./verify.js";

/** Mapped paragraphs plus neighbours handed to one subagent. */
export const RULE_CONTEXT_CHARS = 24_000;
const MAX_CALLS_PER_RULE = 3;

type Mode = Customisation["mode"];
type Core = Omit<Finding, "rule_id" | "rule_title" | "flag" | "model" | "usage" | "cost_usd">;

function finding(ctx: Ctx, rule: Rule, usage: PhaseUsage, core: Core): Finding {
  const redline = ctx.customisation.mode === "redline_only";
  return {
    rule_id: rule.id,
    rule_title: rule.title,
    flag: rule.flag,
    ...core,
    // redline_only carries its reasoning in the suggestion's justification only.
    explanation: redline ? "" : clip(core.explanation, 2000),
    model: usage.models.at(-1) ?? "none",
    usage: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens },
    cost_usd: usage.cost_usd,
  };
}

export function skipped(ctx: Ctx, rule: Rule, usage: PhaseUsage): Finding {
  return finding(ctx, rule, usage, {
    status: "skipped",
    evidence: [],
    explanation: rule.condition ? `Skipped: ${describeCondition(rule.condition)}.` : "Skipped.",
    verification: "ok",
  });
}

/**
 * The clause is missing. Only when the clause map found nothing at all is the model clause
 * offered as an insertion, and only after a paragraph that is actually related.
 */
export function notFound(
  ctx: Ctx,
  rule: Rule,
  usage: PhaseUsage,
  explanation: string,
  offerInsertion: boolean,
): Finding {
  let suggestion: Suggestion | undefined;
  const anchor =
    offerInsertion && rule.sample_language
      ? mostRelated(ctx.scores.get(rule.id), ctx.paragraphs)
      : undefined;
  if (anchor && rule.sample_language) {
    suggestion = {
      id: ctx.newId(),
      rule_id: rule.id,
      anchor: {
        paragraph_index: anchor.index,
        char_from: 0,
        char_to: anchor.text.length,
        para_hash: anchor.para_hash,
      },
      kind: "insert_after",
      before: "",
      after: rule.sample_language,
      justification: clip(
        `The ${rule.title} clause is missing; this adds the playbook's model clause.`,
        2000,
      ),
      status: "pending",
    };
  }
  return finding(ctx, rule, usage, {
    status: "not_found",
    evidence: [],
    matched: "none",
    explanation,
    ...(suggestion ? { suggestion } : {}),
    verification: "ok",
  });
}

export function contextFor(ctx: Ctx, rule: Rule, mapped: readonly number[]): ReviewParagraph[] {
  const scores = ctx.scores.get(rule.id);
  const ranked = [...mapped].sort((a, b) => (scores?.get(b) ?? 0) - (scores?.get(a) ?? 0));
  const wanted: number[] = [...ranked];
  for (const i of ranked) {
    const pos = ctx.position.get(i) ?? 0;
    for (const n of [ctx.paragraphs[pos - 1], ctx.paragraphs[pos + 1]]) if (n) wanted.push(n.index);
  }
  if (ctx.customisation.mode === "in_depth") {
    const text = ranked.map((i) => ctx.byIndex.get(i)?.text ?? "").join("\n");
    for (const [term, at] of ctx.definitions()) if (text.includes(term)) wanted.push(at);
  }
  const picked = new Set<number>();
  let used = 0;
  for (const i of wanted) {
    const p = ctx.byIndex.get(i);
    if (!p || picked.has(i)) continue;
    if (used + p.text.length > RULE_CONTEXT_CHARS && picked.size > 0) continue;
    picked.add(i);
    used += p.text.length;
  }
  return [...picked].sort((a, b) => a - b).flatMap((i) => ctx.byIndex.get(i) ?? []);
}

/** One rule's subagent. Null when the run was aborted; `read` is what it was shown. */
export async function reviewRule(
  ctx: Ctx,
  rule: Rule,
  mapped: readonly number[],
  usage: PhaseUsage,
): Promise<{ finding: Finding; read: number[] } | null> {
  if (mapped.length === 0)
    return {
      finding: notFound(
        ctx,
        rule,
        usage,
        "No paragraph in the document deals with this rule.",
        true,
      ),
      read: [],
    };
  const paras = contextFor(ctx, rule, mapped);
  const read = paras.map((p) => p.index);
  const inCtx = new Map(paras.map((p) => [p.index, p]));
  const c = ctx.customisation;
  const dctx: DraftContext = {
    rule,
    party: c.party,
    paper: c.paper,
    mode: c.mode,
    guidance: ctx.guidance,
    extraContext: ctx.extraContext,
    paragraphs: paras,
  };
  const system = draftSystem(dctx);
  const maxTokens = c.mode === "redline_only" ? 600 : 1200;
  const budget: Budget = { limitMs: ctx.ruleTimeoutMs, spentMs: 0 };
  let retry: { previous: string; errors: string[] } | undefined;
  let verifyRetried = false;
  let timedOut = false;
  let last: { reply: DraftReply; check: Checked } | undefined;

  for (let attempt = 0; attempt < MAX_CALLS_PER_RULE; attempt++) {
    const base = draftPrompt(dctx, ctx.code());
    const prompt = retry ? retryPrompt(base, ctx.code(), retry.previous, retry.errors) : base;
    let text: string;
    try {
      ({ text } = await ctx.call({ task: "draft", system, prompt, maxTokens }, { usage, budget }));
    } catch (err) {
      if (ctx.aborted()) return null;
      if (err instanceof CallTimeout) {
        timedOut = true;
        break;
      }
      continue;
    }
    const parsed = DraftReply.safeParse(parseJsonObject(text));
    if (!parsed.success) {
      retry = {
        previous: text,
        errors: ['reply was not one JSON object in the required shape; "status" is required'],
      };
      continue;
    }
    const reply = parsed.data;
    if (reply.status === "not_found") {
      const why = reply.explanation || "The mapped paragraphs do not deal with this rule.";
      return { finding: notFound(ctx, rule, usage, why, false), read };
    }
    const check = checkReply(reply, inCtx, c.mode);
    last = { reply, check };
    if (check.errors.length === 0)
      return { finding: toFinding(ctx, rule, usage, reply, check, "ok"), read };
    if (verifyRetried) break;
    verifyRetried = true;
    retry = { previous: text, errors: check.errors };
  }
  if (last)
    return {
      finding: toFinding(ctx, rule, usage, last.reply, last.check, "evidence_mismatch"),
      read,
    };
  return {
    finding: finding(ctx, rule, usage, {
      status: "needs_review",
      evidence: [],
      matched: "none",
      explanation: timedOut
        ? "The review of this rule ran out of time; check it by hand."
        : "The model gave no usable answer for this rule; check it by hand.",
      verification: "retry_exhausted",
    }),
    read,
  };
}

export type Checked = {
  errors: string[];
  evidence: Evidence[];
  suggestion?: { p: ReviewParagraph; from: number; to: number; before: string; after: string };
};

const CONSISTENT: Record<string, readonly string[]> = {
  acceptable: ["standard", "fallback"],
  not_acceptable: ["unacceptable", "none"],
};

/** Verifies every quote and the suggestion's `before`, and that status and match agree. */
export function checkReply(
  reply: DraftReply,
  inCtx: ReadonlyMap<number, ReviewParagraph>,
  mode: Mode,
): Checked {
  const errors: string[] = [];
  const allowed = CONSISTENT[reply.status];
  if (allowed && reply.matched && !allowed.includes(reply.matched))
    errors.push(`status "${reply.status}" cannot have matched "${reply.matched}"`);

  const evidence: Evidence[] = [];
  for (const e of reply.evidence) {
    const p = inCtx.get(e.p);
    if (!p) {
      errors.push(`evidence paragraph [${e.p}] is not one of the paragraphs given`);
      continue;
    }
    const section = p.section_path ? { section_path: p.section_path } : {};
    const m = verifyQuote(p.text, e.quote);
    if (m.ok) {
      evidence.push({
        paragraph_index: p.index,
        ...section,
        char_from: m.char_from,
        char_to: m.char_to,
        quote: m.text,
        verified: "ok",
      });
    } else {
      errors.push(`quote "${clip(e.quote, 120)}" is not in paragraph [${e.p}] word for word`);
      evidence.push({
        paragraph_index: p.index,
        ...section,
        char_from: 0,
        char_to: 0,
        quote: clip(e.quote, 2000),
        verified: "mismatch",
      });
    }
  }
  if (!evidence.some((e) => e.verified === "ok"))
    errors.push("give at least one exact quote from the paragraphs as evidence");

  let suggestion: Checked["suggestion"];
  const s = reply.suggestion;
  const required = reply.status === "not_acceptable";
  const allowedHere = required || (reply.status === "needs_review" && mode !== "redline_only");
  if (s && allowedHere) {
    const p = inCtx.get(s.p);
    if (!p || p.excluded) {
      errors.push(`suggestion paragraph [${s.p}] is not an editable paragraph given`);
    } else if (!s.after.trim() || s.after.trim() === s.before.trim()) {
      errors.push('suggestion "after" must be new text that differs from "before"');
    } else {
      const m = verifyQuote(p.text, s.before);
      if (m.ok)
        suggestion = { p, from: m.char_from, to: m.char_to, before: m.text, after: s.after };
      else errors.push(`suggestion "before" is not in paragraph [${s.p}] word for word`);
    }
  } else if (required && !s) {
    errors.push('status "not_acceptable" needs a suggestion with "before" and "after"');
  }
  return { errors, evidence, ...(suggestion ? { suggestion } : {}) };
}

export function toFinding(
  ctx: Ctx,
  rule: Rule,
  usage: PhaseUsage,
  reply: DraftReply,
  check: Checked,
  verification: "ok" | "evidence_mismatch",
): Finding {
  // An unverified finding is never shown as acceptable or not acceptable.
  const status: FindingStatus = verification === "ok" ? reply.status : "needs_review";
  let matched = reply.matched ?? (status === "acceptable" ? "standard" : "none");
  let fallbackIndex: number | undefined;
  if (matched === "fallback") {
    const n = reply.fallback ?? 0;
    if (n >= 1 && n <= rule.fallbacks.length) fallbackIndex = n - 1;
    else if (rule.fallbacks.length === 1) fallbackIndex = 0;
    else if (rule.fallbacks.length === 0) matched = "none";
  }
  let explanation = reply.explanation;
  if (verification === "evidence_mismatch")
    explanation = `${explanation}${explanation ? " " : ""}(Quoted evidence could not be matched to the document; check by hand.)`;
  const s = check.suggestion;
  const suggestion: Suggestion | undefined = s
    ? {
        id: ctx.newId(),
        rule_id: rule.id,
        anchor: {
          paragraph_index: s.p.index,
          char_from: s.from,
          char_to: s.to,
          para_hash: s.p.para_hash,
        },
        kind: "replace",
        before: s.before,
        after: s.after,
        justification: clip(
          reply.explanation || `Brings the clause to the ${rule.title} standard position.`,
          2000,
        ),
        status: "pending",
      }
    : undefined;
  return finding(ctx, rule, usage, {
    status,
    evidence:
      verification === "ok" ? check.evidence.filter((e) => e.verified === "ok") : check.evidence,
    matched,
    ...(fallbackIndex !== undefined ? { matched_fallback_index: fallbackIndex } : {}),
    explanation,
    ...(suggestion ? { suggestion } : {}),
    verification,
  });
}
