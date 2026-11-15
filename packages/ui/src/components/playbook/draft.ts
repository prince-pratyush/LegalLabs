import {
  type Action,
  type Condition,
  Jurisdiction,
  PLAYBOOK_LIMITS,
  type Rule,
  type RuleInput,
} from "@legallabs/contracts";

export type Provenance = NonNullable<Rule["provenance"]>;

/** A rule as the builder edits it: every text a string, so inputs stay controlled. */
export interface EditableRule {
  /** Stable while editing, so React keeps focus when rules move. */
  key: string;
  id?: string;
  title: string;
  standard_position: string;
  fallbacks: string[];
  unacceptable: string;
  guidance: string;
  flag: boolean;
  sample_language: string;
  /** Comma-separated codes, such as "US, UK"; empty means every jurisdiction. */
  jurisdictions: string;
  /** Any condition other than jurisdiction, kept as it was. */
  other_condition?: Condition;
  actions: Action[];
  provenance?: Provenance | null;
}

export interface PlaybookDraft {
  name: string;
  contract_type: string;
  guidance: string;
  rules: EditableRule[];
}

let counter = 0;
const nextKey = () => {
  counter += 1;
  return `rule-${counter}`;
};

type StoredRule = Omit<RuleInput, "fallbacks" | "flag" | "actions"> & {
  fallbacks?: string[];
  flag?: boolean;
  actions?: Action[];
  provenance?: Provenance | null | undefined;
};

export function toEditable(rule: StoredRule): EditableRule {
  const condition = rule.condition;
  return {
    key: nextKey(),
    ...(rule.id ? { id: rule.id } : {}),
    title: rule.title,
    standard_position: rule.standard_position,
    fallbacks: [...(rule.fallbacks ?? [])],
    unacceptable: rule.unacceptable ?? "",
    guidance: rule.guidance ?? "",
    flag: rule.flag ?? false,
    sample_language: rule.sample_language ?? "",
    jurisdictions: condition?.kind === "jurisdiction" ? condition.in.join(", ") : "",
    ...(condition && condition.kind !== "jurisdiction" ? { other_condition: condition } : {}),
    actions: [...(rule.actions ?? [])],
    ...(rule.provenance !== undefined ? { provenance: rule.provenance } : {}),
  };
}

export const blankRule = (): EditableRule => toEditable({ title: "", standard_position: "" });

export const parseJurisdictions = (text: string) =>
  text
    .split(/[\s,]+/)
    .map((code) => code.trim().toUpperCase())
    .filter(Boolean);

const optional = (text: string) => (text.trim() ? { value: text } : null);

/** The rule as the API takes it; provenance stays on the server. */
export function toRuleInput(rule: EditableRule): RuleInput {
  const codes = parseJurisdictions(rule.jurisdictions);
  const condition: Condition | undefined =
    rule.other_condition ?? (codes.length > 0 ? { kind: "jurisdiction", in: codes } : undefined);
  const unacceptable = optional(rule.unacceptable);
  const guidance = optional(rule.guidance);
  const sample = optional(rule.sample_language);
  return {
    ...(rule.id ? { id: rule.id } : {}),
    title: rule.title.trim(),
    standard_position: rule.standard_position,
    fallbacks: rule.fallbacks.filter((f) => f.trim()),
    ...(unacceptable ? { unacceptable: unacceptable.value } : {}),
    ...(guidance ? { guidance: guidance.value } : {}),
    flag: rule.flag,
    actions: rule.actions,
    ...(condition ? { condition } : {}),
    ...(sample ? { sample_language: sample.value } : {}),
  };
}

export function moveRule<T>(rules: readonly T[], from: number, to: number): T[] {
  if (to < 0 || to >= rules.length || from === to) return [...rules];
  const next = [...rules];
  const [moved] = next.splice(from, 1);
  if (moved !== undefined) next.splice(to, 0, moved);
  return next;
}

export type RuleProblems = Partial<Record<"title" | "standard_position" | "jurisdictions", string>>;

/** What stops a save, per rule key, in words an author can act on. */
export function checkDraft(draft: PlaybookDraft): {
  playbook: string[];
  rules: Record<string, RuleProblems>;
} {
  const playbook: string[] = [];
  if (!draft.name.trim()) playbook.push("Give the playbook a name.");
  if (!draft.contract_type.trim()) playbook.push("Say which contract type it covers.");
  if (draft.rules.length > PLAYBOOK_LIMITS.rules) {
    playbook.push(`A playbook can hold up to ${PLAYBOOK_LIMITS.rules} rules.`);
  }
  const seen = new Map<string, number>();
  for (const rule of draft.rules) {
    const title = rule.title.trim().toLowerCase();
    if (title) seen.set(title, (seen.get(title) ?? 0) + 1);
  }
  const rules: Record<string, RuleProblems> = {};
  for (const rule of draft.rules) {
    const problems: RuleProblems = {};
    const title = rule.title.trim().toLowerCase();
    if (!title) problems.title = "Add a title.";
    else if ((seen.get(title) ?? 0) > 1) problems.title = "Another rule has this title.";
    if (!rule.standard_position.trim()) problems.standard_position = "Add the standard position.";
    const bad = parseJurisdictions(rule.jurisdictions).filter(
      (code) => !Jurisdiction.safeParse(code).success,
    );
    if (bad.length > 0) problems.jurisdictions = `Use codes like US, UK or US-CA, not ${bad[0]}.`;
    if (Object.keys(problems).length > 0) rules[rule.key] = problems;
  }
  return { playbook, rules };
}

export const isClean = (problems: ReturnType<typeof checkDraft>) =>
  problems.playbook.length === 0 && Object.keys(problems.rules).length === 0;
