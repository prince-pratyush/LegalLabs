import {
  estimatePages,
  type Finding,
  type FindingStatus,
  type Gap,
  PLAYBOOK_LIMITS,
  type ReviewEvent,
  type Rule,
} from "@legallabs/contracts";
import { mapClauses } from "./clause-map.js";
import { evaluateCondition } from "./condition.js";
import { buildCtx } from "./context.js";
import { gapPass } from "./gaps.js";
import { uuidv7 } from "./id.js";
import { addUsage, emptyUsage, limiter, makeCaller } from "./model.js";
import { reviewRule, skipped } from "./rule.js";
import type { PhaseUsage, ReviewDeps, ReviewInput, ReviewOutcome } from "./types.js";

const MAX_PARALLELISM = 8;
/** A local provider serves about two requests at once; more only queue and burn budget. */
const DEFAULT_PARALLELISM = 2;

/**
 * Runs a playbook review (playbooks-word.md §4.3): clause map, one subagent per rule whose
 * condition holds, and a gap pass over uncovered paragraphs and existing tracked changes.
 * The gap pass starts alongside the first wave of rules. On abort no new call starts and
 * the outcome holds what finished; `review.done` is not emitted.
 */
export async function runReview(input: ReviewInput, deps: ReviewDeps): Promise<ReviewOutcome> {
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? (() => uuidv7(now().getTime()));
  const parallelism = Math.max(
    1,
    Math.min(MAX_PARALLELISM, deps.parallelism ?? DEFAULT_PARALLELISM),
  );
  const call = makeCaller(deps.complete, parallelism, input.signal);
  const ctx = buildCtx(input, call, newId, deps.ruleTimeoutMs ?? 60_000);
  const emit = (e: ReviewEvent) => deps.onEvent?.(e);
  const { customisation } = input;
  const phases = {
    plan: emptyUsage(),
    rules: {} as Record<string, PhaseUsage>,
    verify: emptyUsage(),
  };

  const statuses = new Map<string, FindingStatus | "pending">(
    ctx.rules.map((r) => [r.id, "pending"]),
  );
  // Only rules that can never run are left out; rule_status ones are still "pending".
  const mapRules = ctx.rules.filter(
    (r) => evaluateCondition(r.condition, { customisation, statuses }) !== false,
  );
  const clause_map = await mapClauses(ctx, mapRules, phases.plan);
  const mapped = new Set(Object.values(clause_map).flat());
  const uncovered = ctx.body.map((p) => p.index).filter((i) => !mapped.has(i));

  const excludedCount = ctx.paragraphs.filter((p) => p.excluded).length;
  const warnings: ReviewOutcome["warnings"] = [];
  const chars = ctx.paragraphs.reduce((s, p) => s + p.text.length, 0);
  if (estimatePages(chars) >= PLAYBOOK_LIMITS.warn_pages) warnings.push("over_100_pages");
  if (input.existingEdits.length > 0) warnings.push("existing_tracked_changes");
  emit({
    type: "review.planned",
    clause_map_size: mapped.size,
    rules_in_scope: ctx.rules.length,
    excluded_regions: excludedCount ? { excluded: excludedCount } : {},
    warnings: [...warnings],
  });

  const read = new Set<number>();
  const findings = new Map<string, Finding>();
  const ruleSlots = limiter(parallelism);
  let gapRun: Promise<{ gaps: Gap[]; read: number[] }> | undefined;
  const startGapPass = (checked: Rule[]) => {
    const paras = uncovered.flatMap((i) => ctx.byIndex.get(i) ?? []);
    emit({
      type: "review.gap_pass_started",
      uncovered_count: paras.length,
      existing_edits: input.existingEdits.length,
    });
    gapRun = gapPass(ctx, checked, paras, input.existingEdits, phases.verify).then((r) => {
      if (!ctx.aborted()) emit({ type: "review.gap_pass_finished", gap_count: r.gaps.length });
      return r;
    });
  };

  const runRule = (rule: Rule, holds: boolean) =>
    ruleSlots(async () => {
      if (ctx.aborted()) return;
      emit({ type: "review.rule_started", rule_id: rule.id });
      const usage = emptyUsage();
      phases.rules[rule.id] = usage;
      let f: Finding;
      if (!holds) f = skipped(ctx, rule, usage);
      else {
        const r = await reviewRule(ctx, rule, clause_map[rule.id] ?? [], usage);
        if (!r) return;
        f = r.finding;
        for (const i of r.read) read.add(i);
      }
      findings.set(rule.id, f);
      statuses.set(rule.id, f.status);
      emit({
        type: "review.rule_finished",
        rule_id: rule.id,
        status: f.status,
        has_suggestion: f.suggestion !== undefined,
      });
    });

  let pending = [...ctx.rules];
  while (pending.length > 0 && !ctx.aborted()) {
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
    // The gap pass needs only the clause map and the rules that run, so it overlaps them.
    if (!gapRun) startGapPass(ready.filter((r) => r.holds).map((r) => r.rule));
    await Promise.all(ready.map(({ rule, holds }) => runRule(rule, holds)));
  }
  if (!gapRun && !ctx.aborted()) startGapPass([]);
  const gapResult = gapRun ? await gapRun : { gaps: [], read: [] };
  for (const i of gapResult.read) read.add(i);

  const results = ctx.rules.flatMap((r) => findings.get(r.id) ?? []);
  const gaps = gapResult.gaps;
  const count = (s: FindingStatus) => results.filter((f) => f.status === s).length;
  const summary = {
    acceptable: count("acceptable"),
    needs_review: count("needs_review"),
    not_acceptable: count("not_acceptable"),
    not_found: count("not_found"),
    gaps: gaps.length,
  };
  const total = emptyUsage();
  addUsage(total, phases.plan);
  for (const u of Object.values(phases.rules)) addUsage(total, u);
  addUsage(total, phases.verify);
  const bodyRead = ctx.body.filter((p) => read.has(p.index)).length;
  if (bodyRead < ctx.body.length) warnings.push("partial_coverage");
  const usage = {
    input_tokens: total.input_tokens,
    output_tokens: total.output_tokens,
    cost_usd: total.cost_usd,
  };
  if (!ctx.aborted()) emit({ type: "review.done", summary, usage });

  return {
    clause_map,
    uncovered,
    results,
    gaps,
    summary,
    usage: { ...usage, models: total.models },
    phases,
    coverage: { paragraphs: ctx.body.length, read: bodyRead },
    warnings,
    aborted: ctx.aborted(),
  };
}
