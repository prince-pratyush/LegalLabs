import { CI_LIMITS, CiField } from "@legallabs/contracts";
import { Button, Field, Input, NativeSelect } from "@legallabs/ui";
import { type Picked, PrincipalPicker } from "./PrincipalPicker.js";
import { blankCase, type CaseDraft, type Op, type RuleDraft } from "./rules.js";

const FIELDS: Record<CiField, string> = {
  governing_law: "Governing law",
  counterparty_region: "Counterparty region",
  contract_value: "Contract value",
  contract_type: "Contract type",
};

const OPS: Record<Op, string> = {
  eq: "is",
  in: "is one of",
  gt: "is more than",
  lt: "is less than",
};

function Who({
  who,
  kinds,
  onChange,
}: {
  who: Picked | null;
  kinds: "user" | "group" | "both";
  onChange: (who: Picked | null) => void;
}) {
  if (!who) return <PrincipalPicker kinds={kinds} onPick={onChange} />;
  return (
    <p className="flex items-center gap-2">
      <span>{who.name}</span>
      <Button variant="quiet" size="sm" onClick={() => onChange(null)}>
        Change
      </Button>
    </p>
  );
}

/** One assignment rule: a fixed person, a group taking turns, or cases on a field. */
export function RuleEditor({
  no,
  rule,
  onChange,
  onRemove,
}: {
  no: number;
  rule: RuleDraft;
  onChange: (rule: RuleDraft) => void;
  onRemove: () => void;
}) {
  const setCase = (key: number, patch: Partial<CaseDraft>) =>
    onChange({
      ...rule,
      cases: rule.cases.map((c) => (c.key === key ? { ...c, ...patch } : c)),
    });
  // Only a contract's value is a number that can be more or less than another.
  const ops: Op[] = rule.field === "contract_value" ? ["eq", "in", "gt", "lt"] : ["eq", "in"];

  return (
    <li className="grid gap-2 rounded-md border border-border p-3">
      <div className="flex items-end gap-2">
        <Field label={`Rule ${no}`} className="flex-1">
          {(props) => (
            <NativeSelect
              {...props}
              value={rule.kind}
              onChange={(e) =>
                onChange({ ...rule, kind: e.target.value as RuleDraft["kind"], who: null })
              }
            >
              <option value="fixed">Always the same person</option>
              <option value="field">By a field of the contract</option>
              <option value="round_robin">Take turns through a group</option>
            </NativeSelect>
          )}
        </Field>
        <Button variant="quiet" size="sm" aria-label={`Remove rule ${no}`} onClick={onRemove}>
          Remove
        </Button>
      </div>
      {rule.kind !== "field" ? (
        <Who
          who={rule.who}
          kinds={rule.kind === "fixed" ? "user" : "group"}
          onChange={(who) => onChange({ ...rule, who })}
        />
      ) : (
        <>
          <Field label="Field">
            {(props) => (
              <NativeSelect
                {...props}
                value={rule.field}
                onChange={(e) =>
                  onChange({
                    ...rule,
                    field: e.target.value as CiField,
                    cases: rule.cases.map((c) => ({ ...c, op: c.op === "in" ? "in" : "eq" })),
                  })
                }
              >
                {CiField.options.map((field) => (
                  <option key={field} value={field}>
                    {FIELDS[field]}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
          {rule.cases.map((c) => (
            <div key={c.key} className="grid gap-2 border-l-2 border-border pl-3">
              <Field label="Condition">
                {(props) => (
                  <NativeSelect
                    {...props}
                    value={c.op}
                    onChange={(e) => setCase(c.key, { op: e.target.value as Op })}
                  >
                    {ops.map((op) => (
                      <option key={op} value={op}>
                        {OPS[op]}
                      </option>
                    ))}
                  </NativeSelect>
                )}
              </Field>
              <Field label="Value" {...(c.op === "in" ? { hint: "Separate with commas." } : {})}>
                {(props) => (
                  <Input
                    {...props}
                    value={c.value}
                    onChange={(e) => setCase(c.key, { value: e.target.value })}
                  />
                )}
              </Field>
              <Who who={c.who} kinds="both" onChange={(who) => setCase(c.key, { who })} />
              {rule.cases.length > 1 && (
                <Button
                  variant="quiet"
                  size="sm"
                  className="justify-self-start"
                  onClick={() =>
                    onChange({ ...rule, cases: rule.cases.filter((x) => x.key !== c.key) })
                  }
                >
                  Remove condition
                </Button>
              )}
            </div>
          ))}
          {rule.cases.length < CI_LIMITS.cases && (
            <Button
              variant="quiet"
              size="sm"
              className="justify-self-start"
              onClick={() => onChange({ ...rule, cases: [...rule.cases, blankCase()] })}
            >
              Add condition
            </Button>
          )}
        </>
      )}
    </li>
  );
}
