import { type Card, type CardKind, sortCards } from "../cards/card.js";
import { paraHash } from "../edits/anchor.js";

/**
 * Development only: a fixed review of samples/sample-nda.docx, so tracked changes can be
 * tried in real Word before a playbook server exists. Never part of a production build.
 */
const EDITS: { kind: CardKind; title: string; before: string; after: string; why: string }[] = [
  {
    kind: "not_acceptable",
    title: "Term",
    before: "ten (10) years",
    after: "three (3) years",
    why: "Our standard position: confidentiality obligations last three years.",
  },
  {
    kind: "not_acceptable",
    title: "Liability cap",
    before: "all losses arising from any breach of this Agreement, without limit.",
    after:
      "direct losses arising from any breach of this Agreement, capped at the fees paid in the previous 12 months.",
    why: "Unlimited liability is unacceptable; fall back to a 12-month fee cap.",
  },
  {
    kind: "needs_review",
    title: "Governing law",
    before: "the State of New York",
    after: "New South Wales, Australia",
    why: "We prefer our home jurisdiction; accept the other side's only with approval.",
  },
  {
    kind: "gap",
    title: "Permitted disclosure",
    before: "its employees who need to know it.",
    after:
      "its employees and professional advisers who need to know it and are bound by duties of confidence.",
    why: "Advisers are missing from the permitted recipients.",
  },
];

export async function sampleCards(paragraphs: readonly string[]): Promise<Card[]> {
  const cards: Card[] = [];
  for (const [n, edit] of EDITS.entries()) {
    const index = paragraphs.findIndex((p) => p.includes(edit.before));
    const text = paragraphs[index];
    if (text === undefined) continue;
    cards.push({
      id: `sample-${n}`,
      kind: edit.kind,
      title: edit.title,
      anchor: { paragraph_index: index, para_hash: await paraHash(text) },
      before: edit.before,
      after: edit.after,
      justification: edit.why,
      state: "pending",
      flag: false,
      ruleId: null,
    });
  }
  return sortCards(cards);
}
