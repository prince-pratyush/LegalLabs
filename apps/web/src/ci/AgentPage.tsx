import { CI_LIMITS, type CiAgent, CiAgentCreate, type PlaybookSummary } from "@legallabs/contracts";
import { Button, Checkbox, EmptyState, Field, Input, NativeSelect, Skeleton } from "@legallabs/ui";
import { type FormEvent, useEffect, useId, useState } from "react";
import { ApiError, messageOf } from "../api.js";
import { playbookApi } from "../playbooks/api.js";
import { ciApi } from "./api.js";
import { RuleEditor } from "./RuleEditor.js";
import { goCi } from "./route.js";
import { blankRule, type RuleDraft, toDraft, toRule } from "./rules.js";
import { AgentStatusText } from "./shared.js";

const BLANK = {
  name: "",
  contractType: "",
  playbookId: "",
  party: "",
  paper: "theirs" as CiAgent["paper"],
  minBad: "2",
  flagDeviates: true,
  gapDeviates: true,
};
type Form = typeof BLANK;

const toForm = (a: CiAgent): Form => ({
  name: a.name,
  contractType: a.contract_type,
  playbookId: a.playbook_id,
  party: a.party,
  paper: a.paper,
  minBad: String(a.thresholds.deviates_min_not_acceptable),
  flagDeviates: a.thresholds.flag_rule_deviates,
  gapDeviates: a.thresholds.high_gap_deviates,
});

const MISSING: [keyof Form, string][] = [
  ["name", "Give the agent a name."],
  ["contractType", "Say what type of contract it reviews."],
  ["playbookId", "Choose a playbook."],
  ["party", "Name the party we act for."],
];

/** What to save, or the first thing still wrong with the form. */
function toInput(form: Form, rules: RuleDraft[]): CiAgentCreate | string {
  for (const [key, message] of MISSING) if (!String(form[key]).trim()) return message;
  if (!rules.length) return "Add an assignment rule.";
  const assignment = rules.map(toRule);
  const wrong = assignment.indexOf(null);
  if (wrong >= 0) return `Finish rule ${wrong + 1}.`;
  const input = {
    name: form.name.trim(),
    contract_type: form.contractType.trim(),
    playbook_id: form.playbookId,
    party: form.party.trim(),
    paper: form.paper,
    assignment: assignment.flatMap((rule) => rule ?? []),
    thresholds: {
      deviates_min_not_acceptable: Number(form.minBad),
      flag_rule_deviates: form.flagDeviates,
      high_gap_deviates: form.gapDeviates,
    },
  };
  return CiAgentCreate.safeParse(input).success ? input : "Check the thresholds.";
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (on: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex items-center gap-2">
      <Checkbox id={id} checked={checked} onCheckedChange={(on) => onChange(on === true)} />
      <label htmlFor={id}>{label}</label>
    </div>
  );
}

/** Builds or changes a review agent, and turns it on and off. */
export function AgentPage({ agentId }: { agentId: string | null }) {
  const [agent, setAgent] = useState<CiAgent | null>(null);
  const [form, setForm] = useState<Form>(BLANK);
  const [rules, setRules] = useState<RuleDraft[]>([]);
  const [playbooks, setPlaybooks] = useState<PlaybookSummary[]>([]);
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    playbookApi.list({ status: "published" }).then(setPlaybooks, (err) => setError(messageOf(err)));
  }, []);

  useEffect(() => {
    if (!agentId) return;
    ciApi.agent(agentId).then(
      ({ agent: found, names }) => {
        setAgent(found);
        setForm(toForm(found));
        setRules(found.assignment.map((rule) => toDraft(rule, names)));
      },
      (err) => {
        if (err instanceof ApiError && err.status === 404) setMissing(true);
        else setError(messageOf(err));
      },
    );
  }, [agentId]);

  const set = <K extends keyof Form>(key: K, value: Form[K]) => {
    setSaved(false);
    setForm((f) => ({ ...f, [key]: value }));
  };
  const changeRules = (next: (all: RuleDraft[]) => RuleDraft[]) => {
    setSaved(false);
    setRules(next);
  };

  const act = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  const save = (event: FormEvent) => {
    event.preventDefault();
    const input = toInput(form, rules);
    if (typeof input === "string") return setError(input);
    act(async () => {
      if (!agentId) {
        const made = await ciApi.createAgent(input);
        return goCi({ page: "agent", agentId: made.id });
      }
      setAgent(await ciApi.updateAgent(agentId, input));
      setSaved(true);
    });
  };

  if (missing) {
    return (
      <EmptyState
        title="Review agent not found"
        description="It may belong to someone else."
        action={{ label: "Review agents", onClick: () => goCi({ page: "agents" }) }}
      />
    );
  }
  if (agentId && !agent) {
    return error ? (
      <p role="alert" className="text-destructive">
        {error}
      </p>
    ) : (
      <Skeleton className="h-48 max-w-xl" />
    );
  }

  const live = agent?.status === "live";
  return (
    <form onSubmit={save} noValidate className="grid max-w-xl content-start gap-4">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-title font-semibold">{agent ? agent.name : "New review agent"}</h1>
        {agent && (
          <>
            <AgentStatusText status={agent.status} />
            <span className="ml-auto flex gap-2">
              {live && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => goCi({ page: "submit", agentId: agent.id })}
                >
                  Submit a contract
                </Button>
              )}
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => act(async () => setAgent(await ciApi.setLive(agent.id, !live)))}
              >
                {live ? "Pause" : "Activate"}
              </Button>
            </span>
          </>
        )}
      </header>
      <Field label="Name">
        {(props) => (
          <Input
            {...props}
            value={form.name}
            maxLength={200}
            onChange={(e) => set("name", e.target.value)}
          />
        )}
      </Field>
      <Field label="Contract type">
        {(props) => (
          <Input
            {...props}
            value={form.contractType}
            maxLength={100}
            placeholder="MSA"
            onChange={(e) => set("contractType", e.target.value)}
          />
        )}
      </Field>
      <Field label="Playbook" hint="Only published playbooks can be used.">
        {(props) => (
          <NativeSelect
            {...props}
            value={form.playbookId}
            onChange={(e) => set("playbookId", e.target.value)}
          >
            <option value="">Choose a playbook</option>
            {playbooks.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </NativeSelect>
        )}
      </Field>
      <Field label="Party we act for">
        {(props) => (
          <Input
            {...props}
            value={form.party}
            maxLength={200}
            onChange={(e) => set("party", e.target.value)}
          />
        )}
      </Field>
      <Field label="Whose paper">
        {(props) => (
          <NativeSelect
            {...props}
            value={form.paper}
            onChange={(e) => set("paper", e.target.value as CiAgent["paper"])}
          >
            <option value="theirs">Theirs</option>
            <option value="ours">Ours</option>
          </NativeSelect>
        )}
      </Field>

      <fieldset className="grid gap-2">
        <legend className="text-section font-semibold">Who reviews each contract</legend>
        <p className="text-caption text-fg-muted">
          Fixed people are tried first, then field rules, then groups. If nobody can open a
          contract, it goes to you.
        </p>
        <ul className="grid gap-2">
          {rules.map((rule, i) => (
            <RuleEditor
              key={rule.key}
              no={i + 1}
              rule={rule}
              onChange={(next) =>
                changeRules((all) => all.map((r) => (r.key === next.key ? next : r)))
              }
              onRemove={() => changeRules((all) => all.filter((r) => r.key !== rule.key))}
            />
          ))}
        </ul>
        {rules.length < CI_LIMITS.assignment_rules && (
          <Button
            variant="secondary"
            size="sm"
            className="justify-self-start"
            onClick={() => changeRules((all) => [...all, blankRule()])}
          >
            Add rule
          </Button>
        )}
      </fieldset>

      <fieldset className="grid gap-2">
        <legend className="text-section font-semibold">When a contract deviates</legend>
        <Field label="Not acceptable rules that make a contract deviate">
          {(props) => (
            <Input
              {...props}
              type="number"
              min={1}
              max={200}
              value={form.minBad}
              onChange={(e) => set("minBad", e.target.value)}
            />
          )}
        </Field>
        <Toggle
          label="A flagged rule that is not acceptable always deviates"
          checked={form.flagDeviates}
          onChange={(on) => set("flagDeviates", on)}
        />
        <Toggle
          label="A high-severity issue outside the playbook always deviates"
          checked={form.gapDeviates}
          onChange={(on) => set("gapDeviates", on)}
        />
      </fieldset>

      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={busy}>
          {agentId ? "Save changes" : "Create agent"}
        </Button>
        {saved && (
          <span role="status" className="text-fg-muted">
            Saved
          </span>
        )}
      </div>
    </form>
  );
}
