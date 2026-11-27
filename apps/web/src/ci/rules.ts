import { AssignmentRule, type CiAssignee, CiField } from "@legallabs/contracts";
import type { Picked } from "./PrincipalPicker.js";

export type Op = "eq" | "in" | "gt" | "lt";

export interface CaseDraft {
  key: number;
  op: Op;
  /** As typed; "in" takes a comma-separated list. */
  value: string;
  who: Picked | null;
}

export interface RuleDraft {
  key: number;
  kind: AssignmentRule["kind"];
  /** The person for "fixed", the group for "round_robin". */
  who: Picked | null;
  field: CiField;
  cases: CaseDraft[];
}

let keys = 0;
const nextKey = () => ++keys;

export const blankCase = (): CaseDraft => ({ key: nextKey(), op: "eq", value: "", who: null });
export const blankRule = (): RuleDraft => ({
  key: nextKey(),
  kind: "fixed",
  who: null,
  field: CiField.options[0] as CiField,
  cases: [blankCase()],
});

const picked = (assignee: CiAssignee, names: Record<string, string>): Picked => {
  const [type, id] =
    "user_id" in assignee
      ? (["user", assignee.user_id] as const)
      : (["group", assignee.group_id] as const);
  return { type, id, name: names[id] ?? "Someone no longer listed" };
};

export function toDraft(rule: AssignmentRule, names: Record<string, string>): RuleDraft {
  const draft = { ...blankRule(), kind: rule.kind };
  if (rule.kind === "fixed") draft.who = picked({ user_id: rule.user_id }, names);
  else if (rule.kind === "round_robin") draft.who = picked({ group_id: rule.group_id }, names);
  else {
    draft.field = rule.field;
    draft.cases = rule.cases.map((c) => ({
      key: nextKey(),
      op: c.op,
      value: Array.isArray(c.value) ? c.value.join(", ") : String(c.value),
      who: picked(c.assignee, names),
    }));
  }
  return draft;
}

const assignee = (who: Picked): CiAssignee =>
  who.type === "user" ? { user_id: who.id } : { group_id: who.id };

function toValue(field: CiField, c: CaseDraft) {
  const numeric = field === "contract_value";
  const one = (text: string) => {
    const trimmed = text.trim();
    // Left as text when it isn't a number, so the schema turns it away.
    return numeric && trimmed && Number.isFinite(Number(trimmed)) ? Number(trimmed) : trimmed;
  };
  if (c.op !== "in") return one(c.value);
  return c.value
    .split(",")
    .filter((part) => part.trim())
    .map(one);
}

/** The rule to save, or null while something in it is missing or wrong. */
export function toRule(draft: RuleDraft): AssignmentRule | null {
  let rule: unknown;
  if (draft.kind === "fixed") rule = { kind: "fixed", user_id: draft.who?.id };
  else if (draft.kind === "round_robin") rule = { kind: "round_robin", group_id: draft.who?.id };
  else {
    if (draft.cases.some((c) => !c.who)) return null;
    rule = {
      kind: "field",
      field: draft.field,
      cases: draft.cases.map((c) => ({
        op: c.op,
        value: toValue(draft.field, c),
        assignee: assignee(c.who as Picked),
      })),
    };
  }
  const parsed = AssignmentRule.safeParse(rule);
  return parsed.success ? parsed.data : null;
}
