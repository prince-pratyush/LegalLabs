import { Button, Checkbox, ConfirmDialog, Field, Input, NativeSelect } from "@legallabs/ui";
import { type FormEvent, useState } from "react";
import { messageOf, Panel, useLoad, when } from "../admin/load.js";
import { Card, Nothing, Table } from "../command-center/parts.js";
import { type Estimate, type Policies, type PolicyRow, retentionApi, type Scope } from "./api.js";
import { useStepUp } from "./StepUp.js";
import { TargetPicker } from "./Targets.js";

export const duration = (hours: number | null) => {
  if (hours === null) return "Kept for ever";
  if (hours % 24 === 0) return `${hours / 24} ${hours === 24 ? "day" : "days"}`;
  return `${hours} hours`;
};

const SCOPE_LABEL: Record<Scope, string> = {
  workspace: "Workspace",
  vault: "Vault",
  matter: "Matter",
};

export function PoliciesTab() {
  const state = useLoad(retentionApi.policies, []);
  return (
    <Panel state={state}>
      {(policies) => <Loaded policies={policies} onChanged={state.reload} />}
    </Panel>
  );
}

function Loaded({ policies, onChanged }: { policies: Policies; onChanged: () => void }) {
  const [saved, setSaved] = useState<string | null>(null);
  const stepUp = useStepUp();
  const rows = [
    ...(policies.workspace ? [policies.workspace] : []),
    ...policies.matters,
    ...policies.vaults,
  ];
  const remove = (row: PolicyRow) =>
    stepUp.run(
      () => retentionApi.clearPolicy(row.scope, row.scope === "workspace" ? null : row.scopeId),
      () => {
        setSaved("Policy removed.");
        onChanged();
      },
    );
  return (
    <div className="grid gap-4">
      <p className="max-w-prose text-ui">
        The strictest scope wins: the shorter of the workspace limit and the vault's policy applies.
        A matter policy replaces the vault's, even when it is longer, but it can never go past the
        workspace limit.
      </p>
      <Card title="Policies">
        {!policies.workspace && (
          <Nothing>No workspace limit is set, so nothing expires unless listed below.</Nothing>
        )}
        {rows.length > 0 && (
          <Table
            label="Retention policies"
            head={["Scope", "Name", "Set to", "What applies", ""]}
            rows={rows.map((row) => ({
              key: `${row.scope}:${row.scopeId}`,
              cells: [
                SCOPE_LABEL[row.scope],
                <span key="name">
                  {row.name ?? row.scopeId}
                  {row.source === "legacy" && (
                    <span className="text-fg-muted"> (the vault's own setting)</span>
                  )}
                </span>,
                duration(row.hours),
                duration(row.effectiveHours === undefined ? row.hours : row.effectiveHours),
                <ConfirmDialog
                  key="remove"
                  trigger={
                    <Button
                      variant="quiet"
                      size="sm"
                      aria-label={`Remove ${SCOPE_LABEL[row.scope]} policy ${row.name ?? ""}`}
                    >
                      Remove
                    </Button>
                  }
                  title="Remove this policy?"
                  description="What it covered then follows the remaining policies, with no estimate first. Removing a longer matter policy can let a shorter vault policy apply."
                  confirmLabel="Remove policy"
                  destructive
                  onConfirm={() => remove(row)}
                />,
              ],
            }))}
          />
        )}
        {stepUp.prompt}
      </Card>
      <Editor
        policies={policies}
        onSaved={() => {
          setSaved("Policy saved.");
          onChanged();
        }}
      />
      {saved && <p role="status">{saved}</p>}
      <Card title="Never deleted">
        <ul className="list-disc pl-5 text-ui">
          {policies.exemptions.map((e) => (
            <li key={e.type}>{e.label}</li>
          ))}
        </ul>
        <p className="text-dense text-fg-muted">
          A model provider's prompt cache can hold text for up to 24 hours whatever the policy says.
        </p>
      </Card>
    </div>
  );
}

function Editor({ policies, onSaved }: { policies: Policies; onSaved: () => void }) {
  const [scope, setScope] = useState<Scope>("workspace");
  const [target, setTarget] = useState("");
  const [forever, setForever] = useState(false);
  const [text, setText] = useState("");
  const [slug, setSlug] = useState("");
  // The estimate counts only while it still describes what is on the form.
  const [estimated, setEstimated] = useState<{ key: string; estimate: Estimate } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const stepUp = useStepUp();

  const hours = forever ? null : Number(text);
  const valid =
    (scope === "workspace" || target !== "") &&
    (hours === null || (text.trim() !== "" && Number.isInteger(hours) && hours >= 3));
  const scopeId = scope === "workspace" ? null : target;
  const key = `${scope}:${scopeId}:${hours}`;
  const estimate = estimated?.key === key ? estimated.estimate : null;
  const large = (estimate?.total ?? 0) > 1000;
  const existing =
    scope === "workspace"
      ? policies.workspace
      : (scope === "vault" ? policies.vaults : policies.matters).find((r) => r.scopeId === target);

  const preview = (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    retentionApi
      .estimate(scope, scopeId, hours)
      .then(
        (e) => setEstimated({ key, estimate: e }),
        (e: unknown) => setError(messageOf(e)),
      )
      .finally(() => setBusy(false));
  };

  const save = () =>
    stepUp.run(
      () =>
        retentionApi.setPolicy({
          scope,
          ...(scopeId ? { scope_id: scopeId } : {}),
          hours,
          ...(existing ? { basis: existing.basis } : {}),
          ...(large ? { confirm_slug: slug.trim() } : {}),
        }),
      () => {
        setEstimated(null);
        setSlug("");
        onSaved();
      },
    );

  return (
    <Card title="Set a policy">
      <form onSubmit={preview} className="flex flex-wrap items-end gap-3">
        <Field label="Scope">
          {(props) => (
            <NativeSelect
              {...props}
              value={scope}
              onChange={(e) => {
                setScope(e.target.value as Scope);
                setTarget("");
              }}
            >
              <option value="workspace">Whole workspace</option>
              <option value="vault">One vault</option>
              <option value="matter">One matter</option>
            </NativeSelect>
          )}
        </Field>
        {scope !== "workspace" && (
          <TargetPicker key={scope} kind={scope} value={target} onChange={setTarget} />
        )}
        <Field label="Keep for (hours)" hint="At least 3. 24 hours is a day.">
          {(props) => (
            <Input
              {...props}
              type="number"
              min={3}
              step={1}
              className="w-32"
              disabled={forever}
              value={forever ? "" : text}
              onChange={(e) => setText(e.target.value)}
            />
          )}
        </Field>
        <label htmlFor="retention-forever" className="flex h-8 items-center gap-2 text-ui">
          <Checkbox
            id="retention-forever"
            checked={forever}
            onCheckedChange={(v) => setForever(v === true)}
          />
          Keep for ever
        </label>
        <Button type="submit" variant="secondary" size="sm" disabled={!valid || busy}>
          Estimate
        </Button>
      </form>
      {hours !== null && valid && hours < 24 && (
        <p className="text-warning">Under 24 hours, runs still in progress may fail.</p>
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {estimate ? (
        <div role="status" className="grid gap-1">
          <p className="font-medium">
            {estimate.total === 0
              ? "Nothing would be deleted in the next 24 hours."
              : `${estimate.total} ${estimate.total === 1 ? "item" : "items"} would be deleted within 24 hours.`}
          </p>
          <p className="text-dense text-fg-muted">
            Threads: {estimate.threads}. Files: {estimate.documents}. Review tables:{" "}
            {estimate.reviewTables}. Held and skipped: {estimate.held}. Deleted items stay in the
            recycle bin for 30 days.
            {estimate.firstDeletionAt
              ? ` First deletion about ${when(estimate.firstDeletionAt)}.`
              : ""}
          </p>
        </div>
      ) : (
        <Nothing>Get an estimate to see what would be deleted. Then you can save.</Nothing>
      )}
      {large && (
        <Field
          label="Type the workspace slug to confirm"
          hint="The name you type under Workspace when you sign in."
        >
          {(props) => (
            <Input
              {...props}
              className="max-w-xs"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
            />
          )}
        </Field>
      )}
      <Button
        size="sm"
        className="justify-self-start"
        disabled={!estimate || (large && !slug.trim()) || stepUp.busy}
        onClick={save}
      >
        Save policy
      </Button>
      {stepUp.prompt}
    </Card>
  );
}
