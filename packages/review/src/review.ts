import {
  type Evidence,
  estimatePages,
  type Finding,
  type FindingStatus,
  type Gap,
  normaliseParagraph,
  PLAYBOOK_LIMITS,
  type ReviewEvent,
  type Rule,
  type Suggestion,
} from "@legallabs/contracts";
import { describeCondition, evaluateCondition } from "./condition.js";
import { tagCode, uuidv7 } from "./id.js";
import { parseJsonObject } from "./json.js";
import { lexicalMap, lexicalScores, mostRelated } from "./lexical.js";
import {
  type DraftContext,
  DraftReply,
  draftPrompt,
  draftSystem,
  ExtractReply,
  extractPrompt,
  extractSystem,
  GapReply,
  gapPrompt,
  gapSystem,
  retryPrompt,
} from "./prompts.js";
import type {
  CompleteResult,
  ExistingEdit,
  ReviewDeps,
  ReviewInput,
  ReviewOutcome,
  ReviewParagraph,
  Task,
} from "./types.js";
import { verifyQuote } from "./verify.js";

/** Paragraph characters per clause-map call: ~3k tokens, so a 4B model with an 8k window copes. */
export const EXTRACT_CHUNK_CHARS = 12_000;
/** Characters of paragraphs and edits per gap-pass call. */
export const GAP_CHUNK_CHARS = 12_000;
/** Mapped paragraphs plus neighbours handed to one subagent. */
export const RULE_CONTEXT_CHARS = 24_000;
const MAX_CALLS_PER_RULE = 3;
const MAX_CONCURRENCY = 8;

// Words whose addition or removal never changes meaning; "not", "shall", "may" are not here.
const TRIVIAL = new Set(["a", "an", "the", "and", "of", "to", "in", "on", "at", "by", "for"]);

type Usage = { input_tokens: number; output_tokens: number; cost_usd: number; model: string };

const zeroUsage = (): Usage => ({ input_tokens: 0, output_tokens: 0, cost_usd: 0, model: "none" });

function limiter(n: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active < n) active++;
    else await new Promise<void>((resolve) => queue.push(resolve));
    try {
      return await fn();
    } finally {
      // Hand the slot straight to a waiter so a newcomer can't slip past the cap.
      const next = queue.shift();
      if (next) next();
      else active--;
    }
  };
}

function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("aborted"));
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

function chunk<T>(items: readonly T[], size: (t: T) => number, budget: number): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  let used = 0;
  for (const item of items) {
    const s = size(item);
    if (cur.length > 0 && used + s > budget) {
      out.push(cur);
      cur = [];
      used = 0;
    }
    cur.push(item);
    used += s;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

const isSubstantive = (text: string) =>
  /\d/.test(text) ||
  (text.toLowerCase().match(/[a-z]+/g) ?? []).some((w) => !TRIVIAL.has(w) && w.length > 1);

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** `"Term" means` or `("Term")` definitions, so in-depth reviews can pull them in. */
function definitions(paragraphs: readonly ReviewParagraph[]): Map<string, number> {
  const defs = new Map<string, number>();
  for (const p of paragraphs) {
    for (const m of p.text.matchAll(/["“]([A-Z][A-Za-z ]{1,48}[A-Za-z])["”]/g)) {
      const term = m[1];
      if (term && !defs.has(term)) defs.set(term, p.index);
    }
  }
  return defs;
}

export async function runReview(input: ReviewInput, deps: ReviewDeps): Promise<ReviewOutcome> {
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? (() => uuidv7(now().getTime()));
  const limit = limiter(
    Math.max(1, Math.min(MAX_CONCURRENCY, deps.concurrency ?? MAX_CONCURRENCY)),
  );
  const ruleTimeout = deps.ruleTimeoutMs ?? 60_000;
  const signal = input.signal;
  const { customisation } = input;
  const code = tagCode();
  const emit = (e: ReviewEvent) => deps.onEvent?.(e);
  const aborted = () => signal?.aborted === true;

  const total = { input_tokens: 0, output_tokens: 0, cost_usd: 0 };
  const models = new Set<string>();

  async function call(
    task: Task,
    system: string,
    prompt: string,
    maxTokens: number,
    callSignal: AbortSignal | undefined,
  ): Promise<CompleteResult> {
    if (callSignal?.aborted) throw callSignal.reason ?? new Error("aborted");
    const p = deps.complete({
      task,
      system,
      prompt,
      json: true,
      maxTokens,
      ...(callSignal ? { signal: callSignal } : {}),
    });
    const res = callSignal ? await raceAbort(p, callSignal) : await p;
    total.input_tokens += res.usage.input_tokens;
    total.output_tokens += res.usage.output_tokens;
    total.cost_usd += res.cost_usd;
    models.add(res.model);
    return res;
  }

  const paragraphs = [...input.paragraphs].sort((a, b) => a.index - b.index);
  const byIndex = new Map(paragraphs.map((p) => [p.index, p]));
  const position = new Map(paragraphs.map((p, i) => [p.index, i]));
  const body = paragraphs.filter((p) => !p.excluded && p.text.trim());
  const isBody = (i: number) => {
    const p = byIndex.get(i);
    return p !== undefined && !p.excluded && p.text.trim() !== "";
  };

  const scope = customisation.scope === "all" ? null : new Set(customisation.scope);
  const rules = input.rules
    .filter((r) => !scope || scope.has(r.id))
    .sort((a, b) => a.ordinal - b.ordinal);
  const statuses = new Map<string, FindingStatus | "pending">(rules.map((r) => [r.id, "pending"]));
  // Rules that can never run; rule_status conditions stay "pending" until their rule finishes.
  const mapRules = rules.filter(
    (r) => evaluateCondition(r.condition, { customisation, statuses }) !== false,
  );
  const scores = lexicalScores(paragraphs, mapRules);

  // ---------- 1. clause map ----------

  const clauseMap = await mapClauses();
  const mappedParas = new Set(Object.values(clauseMap).flat());
  const uncovered = body.map((p) => p.index).filter((i) => !mappedParas.has(i));

  const excludedCount = paragraphs.filter((p) => p.excluded).length;
  const excluded_regions: Record<string, number> = excludedCount ? { excluded: excludedCount } : {};
  const warnings: ReviewOutcome["warnings"] = [];
  const chars = paragraphs.reduce((s, p) => s + p.text.length, 0);
  if (estimatePages(chars) >= PLAYBOOK_LIMITS.warn_pages) warnings.push("over_100_pages");
  if (input.existingEdits.length > 0) warnings.push("existing_tracked_changes");

  emit({
    type: "review.planned",
    clause_map_size: mappedParas.size,
    rules_in_scope: rules.length,
    excluded_regions,
    warnings: [...warnings],
  });

  // ---------- 2. per-rule subagents ----------

  const read = new Set<number>();
  const findings = new Map<string, Finding>();
  let pending = [...rules];
  while (pending.length > 0 && !aborted()) {
    const ready: { rule: Rule; holds: boolean }[] = [];
    const wait: Rule[] = [];
    for (const rule of pending) {
      const v = evaluateCondition(rule.condition, { customisation, statuses });
      if (v === "pending") wait.push(rule);
      else ready.push({ rule, holds: v });
    }
    // Nothing ready means a rule_status cycle: those rules can't be decided, so skip them.
    if (ready.length === 0) for (const rule of wait.splice(0)) ready.push({ rule, holds: false });
    pending = wait;
    await Promise.all(
      ready.map(({ rule, holds }) =>
        limit(async () => {
          if (aborted()) return;
          emit({ type: "review.rule_started", rule_id: rule.id });
          const f = holds ? await reviewRule(rule) : skipped(rule);
          if (!f) return;
          findings.set(rule.id, f);
          statuses.set(rule.id, f.status);
          emit({
            type: "review.rule_finished",
            rule_id: rule.id,
            status: f.status,
            has_suggestion: f.suggestion !== undefined,
          });
        }),
      ),
    );
  }
  const results = rules.flatMap((r) => findings.get(r.id) ?? []);

  // ---------- 3. gap pass ----------

  let gaps: Gap[] = [];
  if (!aborted()) {
    const gapParas = body.filter((p) => !read.has(p.index));
    emit({
      type: "review.gap_pass_started",
      uncovered_count: gapParas.length,
      existing_edits: input.existingEdits.length,
    });
    gaps = await gapPass(gapParas);
    if (!aborted()) emit({ type: "review.gap_pass_finished", gap_count: gaps.length });
  }

  const count = (s: FindingStatus) => results.filter((f) => f.status === s).length;
  const summary = {
    acceptable: count("acceptable"),
    needs_review: count("needs_review"),
    not_acceptable: count("not_acceptable"),
    not_found: count("not_found"),
    gaps: gaps.length,
  };
  if (read.size < body.length) warnings.push("partial_coverage");
  if (!aborted()) emit({ type: "review.done", summary, usage: { ...total } });

  return {
    clause_map: clauseMap,
    uncovered,
    results,
    gaps,
    summary,
    usage: { ...total, models: [...models] },
    coverage: { paragraphs: body.length, read: [...read].filter(isBody).length },
    warnings,
    aborted: aborted(),
  };

  // ---------- helpers (hoisted; they close over the state above) ----------

  async function mapClauses(): Promise<Record<string, number[]>> {
    const lex = lexicalMap(paragraphs, mapRules);
    const map = new Map<string, Set<number>>(mapRules.map((r) => [r.id, new Set<number>()]));
    if (mapRules.length === 0) return {};
    const coded = mapRules.map((rule, i) => ({ code: `R${i + 1}`, rule }));
    const byCode = new Map(coded.map((c) => [c.code.toLowerCase(), c.rule.id]));
    const chunks = chunk(body, (p) => Math.min(p.text.length, 1500) + 20, EXTRACT_CHUNK_CHARS);
    await Promise.all(
      chunks.map((part) =>
        limit(async () => {
          const inChunk = new Set(part.map((p) => p.index));
          let assigned: Map<number, string[]> | undefined;
          if (!aborted()) {
            try {
              const res = await call(
                "extract",
                extractSystem(code),
                extractPrompt(code, coded, part),
                Math.min(4096, 64 + part.length * 24),
                signal,
              );
              const parsed = ExtractReply.safeParse(parseJsonObject(res.text));
              if (parsed.success) {
                assigned = new Map();
                for (const { i, types } of parsed.data.paragraphs) {
                  if (!inChunk.has(i)) continue;
                  const ids = types.flatMap((t) => byCode.get(t.trim().toLowerCase()) ?? []);
                  assigned.set(i, ids);
                }
              }
            } catch {
              // Lexical fallback below; an abort is noticed by the caller.
            }
          }
          if (assigned) {
            for (const [i, ids] of assigned) for (const id of ids) map.get(id)?.add(i);
          } else {
            for (const [id, idxs] of Object.entries(lex.clause_map))
              for (const i of idxs) if (inChunk.has(i)) map.get(id)?.add(i);
          }
        }),
      ),
    );
    // A small model misses clauses; give an unmapped rule its strong lexical match and let
    // the subagent answer not_found if that guess is wrong.
    for (const [id, set] of map) {
      const top = lex.clause_map[id]?.[0];
      if (set.size === 0 && top !== undefined) set.add(top);
    }
    return Object.fromEntries(
      [...map].map(([id, set]) => [id, [...set].sort((a, b) => a - b)] as const),
    );
  }

  function skipped(rule: Rule): Finding {
    return {
      rule_id: rule.id,
      rule_title: rule.title,
      status: "skipped",
      flag: rule.flag,
      evidence: [],
      explanation: rule.condition ? `Skipped: ${describeCondition(rule.condition)}.` : "Skipped.",
      verification: "ok",
      model: "none",
      usage: { input_tokens: 0, output_tokens: 0 },
      cost_usd: 0,
    };
  }

  function finding(
    rule: Rule,
    u: Usage,
    rest: Omit<Finding, "rule_id" | "rule_title" | "flag" | "model" | "usage" | "cost_usd">,
  ): Finding {
    return {
      rule_id: rule.id,
      rule_title: rule.title,
      flag: rule.flag,
      ...rest,
      explanation: clip(rest.explanation, 2000),
      model: u.model,
      usage: { input_tokens: u.input_tokens, output_tokens: u.output_tokens },
      cost_usd: u.cost_usd,
    };
  }

  function notFound(rule: Rule, u: Usage, explanation: string): Finding {
    let suggestion: Suggestion | undefined;
    const anchor = rule.sample_language ? mostRelated(scores.get(rule.id), paragraphs) : undefined;
    if (rule.sample_language && anchor) {
      suggestion = {
        id: newId(),
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
    return finding(rule, u, {
      status: "not_found",
      evidence: [],
      matched: "none",
      explanation: customisation.mode === "redline_only" && !suggestion ? "" : explanation,
      ...(suggestion ? { suggestion } : {}),
      verification: "ok",
    });
  }

  function contextFor(rule: Rule): ReviewParagraph[] {
    const mapped = [...(clauseMap[rule.id] ?? [])].sort(
      (a, b) => (scores.get(rule.id)?.get(b) ?? 0) - (scores.get(rule.id)?.get(a) ?? 0),
    );
    const wanted: number[] = [...mapped];
    for (const i of mapped) {
      const pos = position.get(i) ?? 0;
      for (const n of [paragraphs[pos - 1], paragraphs[pos + 1]]) if (n) wanted.push(n.index);
    }
    if (customisation.mode === "in_depth") {
      const defs = definitions(paragraphs);
      const text = mapped.map((i) => byIndex.get(i)?.text ?? "").join("\n");
      for (const [term, at] of defs) if (text.includes(term)) wanted.push(at);
    }
    const picked = new Set<number>();
    let used = 0;
    for (const i of wanted) {
      const p = byIndex.get(i);
      if (!p || picked.has(i)) continue;
      if (used + p.text.length > RULE_CONTEXT_CHARS && picked.size > 0) continue;
      picked.add(i);
      used += p.text.length;
    }
    return [...picked].sort((a, b) => a - b).flatMap((i) => byIndex.get(i) ?? []);
  }

  async function reviewRule(rule: Rule): Promise<Finding | null> {
    const u = zeroUsage();
    if ((clauseMap[rule.id] ?? []).length === 0)
      return notFound(rule, u, "No paragraph in the document deals with this rule.");

    const ctxParas = contextFor(rule);
    for (const p of ctxParas) read.add(p.index);
    const ctx: DraftContext = {
      code,
      rule,
      party: customisation.party,
      paper: customisation.paper,
      mode: customisation.mode,
      guidance: input.guidance,
      extraContext: input.extraContext,
      paragraphs: ctxParas,
    };
    const inCtx = new Map(ctxParas.map((p) => [p.index, p]));

    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort(new Error("rule timed out"));
    }, ruleTimeout);
    const onParentAbort = () => ctrl.abort(signal?.reason);
    signal?.addEventListener("abort", onParentAbort, { once: true });

    const system = draftSystem(ctx);
    const base = draftPrompt(ctx);
    let prompt = base;
    let verifyRetried = false;
    let last: { reply: DraftReply; check: Checked } | undefined;
    try {
      for (let attempt = 0; attempt < MAX_CALLS_PER_RULE; attempt++) {
        let res: CompleteResult;
        try {
          res = await call("draft", system, prompt, 1200, ctrl.signal);
        } catch {
          if (aborted()) return null;
          if (timedOut) break;
          continue;
        }
        u.input_tokens += res.usage.input_tokens;
        u.output_tokens += res.usage.output_tokens;
        u.cost_usd += res.cost_usd;
        u.model = res.model;
        const parsed = DraftReply.safeParse(parseJsonObject(res.text));
        if (!parsed.success) {
          prompt = retryPrompt(base, res.text, [
            'reply was not one JSON object in the required shape; "status" is required',
          ]);
          continue;
        }
        const reply = parsed.data;
        if (reply.status === "not_found") {
          return notFound(
            rule,
            u,
            reply.explanation || "The mapped paragraphs do not deal with this rule.",
          );
        }
        const check = checkReply(reply, inCtx);
        last = { reply, check };
        if (check.errors.length === 0) return accepted(rule, u, reply, check, "ok");
        if (verifyRetried) break;
        verifyRetried = true;
        prompt = retryPrompt(base, res.text, check.errors);
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onParentAbort);
    }
    if (aborted()) return null;
    if (last) return accepted(rule, u, last.reply, last.check, "evidence_mismatch");
    return finding(rule, u, {
      status: "needs_review",
      evidence: [],
      matched: "none",
      explanation: timedOut
        ? "The review of this rule timed out; check it by hand."
        : "The model gave no usable answer for this rule; check it by hand.",
      verification: "retry_exhausted",
    });
  }

  type Checked = {
    errors: string[];
    evidence: Evidence[];
    suggestion?: { p: ReviewParagraph; from: number; to: number; before: string; after: string };
  };

  function checkReply(reply: DraftReply, inCtx: Map<number, ReviewParagraph>): Checked {
    const errors: string[] = [];
    const evidence: Evidence[] = [];
    for (const e of reply.evidence) {
      const p = inCtx.get(e.p);
      if (!p) {
        errors.push(`evidence paragraph [${e.p}] is not one of the paragraphs given`);
        continue;
      }
      const m = verifyQuote(p.text, e.quote);
      if (m.ok) {
        evidence.push({
          paragraph_index: p.index,
          ...(p.section_path ? { section_path: p.section_path } : {}),
          char_from: m.char_from,
          char_to: m.char_to,
          quote: m.text,
          verified: "ok",
        });
      } else {
        errors.push(`quote "${clip(e.quote, 120)}" is not in paragraph [${e.p}] word for word`);
        evidence.push({
          paragraph_index: p.index,
          ...(p.section_path ? { section_path: p.section_path } : {}),
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
    const wantsSuggestion = reply.status === "not_acceptable";
    if (
      s &&
      (wantsSuggestion ||
        (reply.status === "needs_review" && customisation.mode !== "redline_only"))
    ) {
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
    } else if (wantsSuggestion && !s) {
      errors.push('status "not_acceptable" needs a suggestion with "before" and "after"');
    }
    return { errors, evidence, ...(suggestion ? { suggestion } : {}) };
  }

  function accepted(
    rule: Rule,
    u: Usage,
    reply: DraftReply,
    check: Checked,
    verification: "ok" | "evidence_mismatch",
  ): Finding {
    // Unverified findings are never shown as acceptable or not acceptable.
    const status: FindingStatus =
      verification === "ok" ? (reply.status as FindingStatus) : "needs_review";
    let matched = reply.matched ?? (status === "acceptable" ? "standard" : "none");
    let fallbackIndex: number | undefined;
    if (matched === "fallback") {
      const n = reply.fallback ?? 0;
      if (n >= 1 && n <= rule.fallbacks.length) fallbackIndex = n - 1;
      else if (rule.fallbacks.length === 1) fallbackIndex = 0;
      else if (rule.fallbacks.length === 0) matched = "none";
    }
    let explanation = reply.explanation;
    if (customisation.mode === "redline_only" && status === "acceptable") explanation = "";
    if (verification === "evidence_mismatch")
      explanation = `${explanation}${explanation ? " " : ""}(Quoted evidence could not be matched to the document; check by hand.)`;
    const s = check.suggestion;
    const suggestion: Suggestion | undefined = s
      ? {
          id: newId(),
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
    return finding(rule, u, {
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

  async function gapPass(gapParas: ReviewParagraph[]): Promise<Gap[]> {
    const edits = input.existingEdits.map((edit, i) => ({ ref: `E${i + 1}`, edit }));
    type Item =
      | { kind: "edit"; ref: string; edit: ExistingEdit }
      | { kind: "para"; p: ReviewParagraph };
    const items: Item[] = [
      ...edits.map((e) => ({ kind: "edit" as const, ...e })),
      ...gapParas.map((p) => ({ kind: "para" as const, p })),
    ];
    const parts = chunk(
      items,
      (it) =>
        (it.kind === "edit"
          ? Math.min(it.edit.text.length, 1500)
          : Math.min(it.p.text.length, 3000)) + 40,
      GAP_CHUNK_CHARS,
    );
    const gaps: Gap[] = [];
    const seen = new Set<string>();
    const mentioned = new Set<string>();
    const editByRef = new Map(edits.map((e) => [e.ref, e.edit]));

    await Promise.all(
      parts.map((part) =>
        limit(async () => {
          if (aborted()) return;
          const partEdits = part.flatMap((it) =>
            it.kind === "edit" ? [{ ref: it.ref, edit: it.edit }] : [],
          );
          const partParas = part.flatMap((it) => (it.kind === "para" ? [it.p] : []));
          for (const p of partParas) read.add(p.index);
          const paraSet = new Set(partParas.map((p) => p.index));
          const base = gapPrompt(code, rules, partEdits, partParas);
          let prompt = base;
          for (let attempt = 0; attempt < 2; attempt++) {
            let res: CompleteResult;
            try {
              res = await call(
                "verify",
                gapSystem(code, customisation.party),
                prompt,
                1500,
                signal,
              );
            } catch {
              if (aborted()) return;
              continue;
            }
            const parsed = GapReply.safeParse(parseJsonObject(res.text));
            if (!parsed.success) {
              prompt = retryPrompt(base, res.text, [
                'reply was not {"gaps":[...]} in the required shape',
              ]);
              continue;
            }
            for (const g of parsed.data.gaps) {
              const m = /^\s*\[?\s*([PE])\s*(\d+)\s*\]?\s*$/i.exec(g.ref);
              if (!m) continue;
              const ref = `${(m[1] ?? "").toUpperCase()}${m[2]}`;
              if (seen.has(ref)) continue;
              const gap = ref.startsWith("E")
                ? editGap(editByRef.get(ref), g.quote, g.reason, g.severity)
                : paraGap(
                    paraSet.has(Number(m[2])) ? byIndex.get(Number(m[2])) : undefined,
                    g.quote,
                    g.reason,
                    g.severity,
                  );
              if (!gap) continue;
              seen.add(ref);
              if (ref.startsWith("E")) mentioned.add(ref);
              gaps.push(gap);
            }
            return;
          }
        }),
      ),
    );
    if (aborted()) return gaps;

    // Recall guard: a substantive tracked change the model passed over still gets a gap.
    for (const { ref, edit } of edits) {
      if (mentioned.has(ref) || !isSubstantive(edit.text)) continue;
      const verb = edit.kind === "ins" ? "insertion" : "deletion";
      const by = edit.author ? ` by ${clip(edit.author, 80)}` : "";
      const gap = editGap(
        edit,
        "",
        `Tracked ${verb}${by} that no playbook rule or gap check addressed; review it before accepting.`,
        "low",
      );
      if (gap) gaps.push(gap);
    }
    return gaps;
  }

  function paraGap(
    p: ReviewParagraph | undefined,
    quote: string,
    reason: string,
    severity: Gap["severity"],
  ): Gap | undefined {
    if (!p || p.excluded) return undefined;
    const m = quote ? verifyQuote(p.text, quote) : undefined;
    // An unverifiable quote falls back to the whole paragraph, which is verified by definition.
    const evidence: Evidence = m?.ok
      ? {
          paragraph_index: p.index,
          char_from: m.char_from,
          char_to: m.char_to,
          quote: m.text,
          verified: "ok",
        }
      : {
          paragraph_index: p.index,
          char_from: 0,
          char_to: p.text.length,
          quote: p.text,
          verified: "ok",
        };
    if (p.section_path) evidence.section_path = p.section_path;
    return {
      id: newId(),
      kind: "uncovered_clause",
      evidence: [evidence],
      reason: clip(reason || "Material clause that no playbook rule covers.", 1000),
      severity,
    };
  }

  function editGap(
    edit: ExistingEdit | undefined,
    quote: string,
    reason: string,
    severity: Gap["severity"],
  ): Gap | undefined {
    if (!edit) return undefined;
    const p = byIndex.get(edit.paragraph_index);
    let evidence: Evidence | undefined;
    for (const q of [quote, edit.text]) {
      const m = p && q ? verifyQuote(p.text, q) : undefined;
      if (m?.ok) {
        evidence = {
          paragraph_index: edit.paragraph_index,
          char_from: m.char_from,
          char_to: m.char_to,
          quote: m.text,
          verified: "ok",
        };
        break;
      }
    }
    // Deleted text is not in the paragraph's visible text; the tracked change itself is the evidence.
    evidence ??= {
      paragraph_index: edit.paragraph_index,
      char_from: 0,
      char_to: 0,
      quote: normaliseParagraph(edit.text),
      verified: "ok",
    };
    if (p?.section_path) evidence.section_path = p.section_path;
    return {
      id: newId(),
      kind: "existing_edit",
      evidence: [evidence],
      reason: clip(reason || "Existing tracked change that changes the deal.", 1000),
      severity,
    };
  }
}
