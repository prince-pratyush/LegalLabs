import type { Rule } from "@legallabs/contracts";
import { type Ctx, chunk } from "./context.js";
import { parseJsonObject } from "./json.js";
import { lexicalMap } from "./lexical.js";
import { EXTRACT_SYSTEM, ExtractReply, extractPrompt, ruleLine } from "./prompts.js";
import type { PhaseUsage, ReviewParagraph } from "./types.js";

/** Rules plus paragraphs per clause-map call: ~3k tokens, which a 4B model's window holds. */
export const EXTRACT_CHUNK_CHARS = 12_000;
/** The rule list may take at most half a call; 200 rules are split into groups. */
const RULE_GROUP_CHARS = EXTRACT_CHUNK_CHARS / 2;
/** A rule whose best paragraph scores this and twice its runner-up skips the model. */
export const CONFIDENT_SCORE = 6;

export function isConfident(scores: Map<number, number> | undefined): boolean {
  const ranked = [...(scores?.values() ?? [])].sort((a, b) => b - a);
  const best = ranked[0] ?? 0;
  return best >= CONFIDENT_SCORE && (ranked[1] ?? 0) * 2 <= best;
}

/**
 * Rule id → mapped paragraph indexes. Lexically confident rules are mapped without the
 * model; the rest go to the model in rule groups × paragraph chunks, never splitting a
 * paragraph. A chunk whose reply is unusable falls back to the lexical map.
 */
export async function mapClauses(
  ctx: Ctx,
  mapRules: readonly Rule[],
  usage: PhaseUsage,
): Promise<Record<string, number[]>> {
  if (mapRules.length === 0) return {};
  const lex = lexicalMap(ctx.paragraphs, mapRules, {}, ctx.scores);
  const map = new Map(mapRules.map((r) => [r.id, new Set<number>()]));
  const modelRules: Rule[] = [];
  for (const rule of mapRules) {
    if (isConfident(ctx.scores.get(rule.id)))
      for (const i of lex.clause_map[rule.id] ?? []) map.get(rule.id)?.add(i);
    else modelRules.push(rule);
  }

  const coded = modelRules.map((rule, i) => ({ code: `R${i + 1}`, rule }));
  const size = (c: (typeof coded)[number]) => ruleLine(c.code, c.rule).length + 1;
  const jobs: Promise<void>[] = [];
  for (const group of chunk(coded, size, RULE_GROUP_CHARS)) {
    const ruleChars = group.reduce((s, c) => s + size(c), 0);
    const budget = EXTRACT_CHUNK_CHARS - ruleChars;
    for (const part of chunk(ctx.body, (p) => Math.min(p.text.length, 1500) + 20, budget))
      jobs.push(mapPart(group, part));
  }
  await Promise.all(jobs);

  // A small model misses clauses; give an unmapped rule its strong lexical match and let
  // the subagent answer not_found if that guess is wrong.
  for (const [id, set] of map) {
    const top = lex.clause_map[id]?.[0];
    if (set.size === 0 && top !== undefined) set.add(top);
  }
  return Object.fromEntries([...map].map(([id, set]) => [id, [...set].sort((a, b) => a - b)]));

  async function mapPart(group: { code: string; rule: Rule }[], part: ReviewParagraph[]) {
    const inPart = new Set(part.map((p) => p.index));
    const byCode = new Map(group.map((c) => [c.code.toLowerCase(), c.rule.id]));
    let assigned: [string, number[]][] | undefined;
    if (!ctx.aborted()) {
      try {
        const res = await ctx.call(
          {
            task: "extract",
            system: EXTRACT_SYSTEM,
            prompt: extractPrompt(ctx.code(), group, part),
            maxTokens: Math.min(2048, 64 + group.length * 32),
          },
          { usage },
        );
        const parsed = ExtractReply.safeParse(parseJsonObject(res.text));
        const entries = parsed.success ? Object.entries(parsed.data) : [];
        const known = entries.filter(([k]) => byCode.has(k.trim().toLowerCase()));
        // "{}" means nothing matched; keys that are all unknown mean the shape was ignored.
        if (parsed.success && (entries.length === 0 || known.length > 0))
          assigned = known.map(([k, idxs]) => [
            byCode.get(k.trim().toLowerCase()) ?? "",
            idxs.filter((i) => inPart.has(i)),
          ]);
      } catch {
        // Lexical fallback below; an abort is noticed by the caller.
      }
    }
    if (!assigned)
      assigned = group.map((c) => [
        c.rule.id,
        (lex.clause_map[c.rule.id] ?? []).filter((i) => inPart.has(i)),
      ]);
    for (const [id, idxs] of assigned) for (const i of idxs) map.get(id)?.add(i);
  }
}
