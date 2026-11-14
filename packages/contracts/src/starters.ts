// JSON stays outside src so non-developers can edit it; the import resolves to
// ../playbooks from both src and dist, so the package ships playbooks/ beside dist/.
import msa from "../playbooks/starters/msa.json" with { type: "json" };
import nda from "../playbooks/starters/nda.json" with { type: "json" };
import type { RuleInput, StarterTemplate } from "./playbook.js";

export type Starter = {
  name: string;
  contract_type: string;
  guidance: string;
  rules: RuleInput[];
};

// JSON widens literals (condition kinds), so the cast is checked by starters.test.ts instead.
export const STARTERS: Readonly<Record<StarterTemplate, Starter>> = {
  nda: nda as Starter,
  msa: msa as Starter,
};

/** A fresh copy of a starter: playbooks clone starters, never reference them. */
export const starterPlaybook = (template: StarterTemplate): Starter =>
  structuredClone(STARTERS[template]);
