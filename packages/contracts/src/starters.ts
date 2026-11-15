// JSON stays outside src so non-developers can edit it; the import resolves to
// ../playbooks from both src and dist, so the package ships playbooks/ beside dist/.
import type { z } from "zod";
import msa from "../playbooks/starters/msa.json" with { type: "json" };
import nda from "../playbooks/starters/nda.json" with { type: "json" };
import { PlaybookPatch, type StarterTemplate } from "./playbook.js";

/** A starter is a complete playbook patch whose global guidance is required. */
export const StarterPlaybook = PlaybookPatch.required().extend({
  guidance: PlaybookPatch.shape.guidance.unwrap().unwrap().min(1),
});
export type StarterPlaybook = z.output<typeof StarterPlaybook>;

const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
};

// Parsed at load so a bad edit to the JSON fails on import, not mid-review.
export const STARTERS: Readonly<Record<StarterTemplate, StarterPlaybook>> = deepFreeze({
  nda: StarterPlaybook.parse(nda),
  msa: StarterPlaybook.parse(msa),
});

/** A mutable copy of a starter: playbooks clone starters, never reference them. */
export const starterPlaybook = (template: StarterTemplate): StarterPlaybook =>
  structuredClone(STARTERS[template]);
