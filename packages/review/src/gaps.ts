import { type Evidence, type Gap, normaliseParagraph, type Rule } from "@legallabs/contracts";
import { type Ctx, chunk, clip } from "./context.js";
import { parseJsonObject } from "./json.js";
import { GapReply, gapPrompt, gapSystem, retryPrompt } from "./prompts.js";
import type { ExistingEdit, PhaseUsage, ReviewParagraph } from "./types.js";
import { verifyQuote } from "./verify.js";

/** Characters of paragraphs and edits per gap-pass call. */
export const GAP_CHUNK_CHARS = 12_000;

// Words whose addition or removal never changes meaning; "not", "shall", "may" are not here.
const TRIVIAL = new Set(["a", "an", "the", "and", "of", "to", "in", "on", "at", "by", "for"]);

export const isSubstantive = (text: string) =>
  /\d/.test(text) ||
  (text.toLowerCase().match(/[a-z]+/g) ?? []).some((w) => !TRIVIAL.has(w) && w.length > 1);

type Item =
  | { kind: "edit"; ref: string; edit: ExistingEdit }
  | { kind: "para"; p: ReviewParagraph };

/**
 * Uncovered paragraphs and every existing tracked change, checked against the rules that
 * ran. A substantive tracked change the model passed over still gets a low gap, so recall
 * never drops silently, even when every call fails. `read` is what the model was shown.
 */
export async function gapPass(
  ctx: Ctx,
  checked: readonly Rule[],
  uncovered: readonly ReviewParagraph[],
  existingEdits: readonly ExistingEdit[],
  usage: PhaseUsage,
): Promise<{ gaps: Gap[]; read: number[] }> {
  const edits = existingEdits.map((edit, i) => ({ ref: `E${i + 1}`, edit }));
  const items: Item[] = [
    ...edits.map((e) => ({ kind: "edit" as const, ...e })),
    ...uncovered.map((p) => ({ kind: "para" as const, p })),
  ];
  const size = (it: Item) =>
    (it.kind === "edit" ? Math.min(it.edit.text.length, 1500) : Math.min(it.p.text.length, 3000)) +
    40;
  const gaps: Gap[] = [];
  const read: number[] = [];
  const seen = new Set<string>();
  const editByRef = new Map(edits.map((e) => [e.ref, e.edit]));
  const system = gapSystem(ctx.customisation.party);

  await Promise.all(
    chunk(items, size, GAP_CHUNK_CHARS).map(async (part) => {
      if (ctx.aborted()) return;
      const partEdits = part.flatMap((it) => (it.kind === "edit" ? [it] : []));
      const partParas = part.flatMap((it) => (it.kind === "para" ? [it.p] : []));
      const inPart = new Set(partParas.map((p) => p.index));
      let retry: { previous: string } | undefined;
      let shown = false;
      for (let attempt = 0; attempt < 2; attempt++) {
        const base = gapPrompt(ctx.code(), checked, partEdits, partParas);
        const prompt = retry
          ? retryPrompt(base, ctx.code(), retry.previous, [
              'reply was not {"gaps":[...]} in the required shape',
            ])
          : base;
        let text: string;
        try {
          ({ text } = await ctx.call(
            { task: "verify", system, prompt, maxTokens: 1500 },
            { usage },
          ));
        } catch {
          if (ctx.aborted()) return;
          continue;
        }
        if (!shown) read.push(...inPart);
        shown = true;
        const parsed = GapReply.safeParse(parseJsonObject(text));
        if (!parsed.success) {
          retry = { previous: text };
          continue;
        }
        for (const g of parsed.data.gaps) {
          const m = /^\s*\[?\s*([PE])\s*(\d+)\s*\]?\s*$/i.exec(g.ref);
          if (!m) continue;
          const ref = `${(m[1] ?? "").toUpperCase()}${m[2]}`;
          if (seen.has(ref)) continue;
          const n = Number(m[2]);
          const gap = ref.startsWith("E")
            ? editGap(ctx, editByRef.get(ref), g.quote, g.reason, g.severity)
            : paraGap(
                ctx,
                inPart.has(n) ? ctx.byIndex.get(n) : undefined,
                g.quote,
                g.reason,
                g.severity,
              );
          if (!gap) continue;
          seen.add(ref);
          gaps.push(gap);
        }
        return;
      }
    }),
  );
  if (ctx.aborted()) return { gaps, read };

  for (const { ref, edit } of edits) {
    if (seen.has(ref) || !isSubstantive(edit.text)) continue;
    const verb = edit.kind === "ins" ? "insertion" : "deletion";
    const by = edit.author ? ` by ${clip(edit.author, 80)}` : "";
    const reason = `Tracked ${verb}${by} that no playbook rule or gap check addressed; review it before accepting.`;
    const gap = editGap(ctx, edit, "", reason, "low");
    if (gap) gaps.push(gap);
  }
  return { gaps, read };
}

function paraGap(
  ctx: Ctx,
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
    id: ctx.newId(),
    kind: "uncovered_clause",
    evidence: [evidence],
    reason: clip(reason || "Material clause that no playbook rule covers.", 1000),
    severity,
  };
}

function editGap(
  ctx: Ctx,
  edit: ExistingEdit | undefined,
  quote: string,
  reason: string,
  severity: Gap["severity"],
): Gap | undefined {
  if (!edit) return undefined;
  const p = ctx.byIndex.get(edit.paragraph_index);
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
  // Deleted text is not in the paragraph's visible text; the tracked change is the evidence.
  evidence ??= {
    paragraph_index: edit.paragraph_index,
    char_from: 0,
    char_to: 0,
    quote: normaliseParagraph(edit.text),
    verified: "ok",
  };
  if (p?.section_path) evidence.section_path = p.section_path;
  return {
    id: ctx.newId(),
    kind: "existing_edit",
    evidence: [evidence],
    reason: clip(reason || "Existing tracked change that changes the deal.", 1000),
    severity,
  };
}
