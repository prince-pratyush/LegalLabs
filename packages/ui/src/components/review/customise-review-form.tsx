import { Jurisdiction, PLAYBOOK_LIMITS, type ReviewRequest } from "@legallabs/contracts";
import { type FormEvent, useId, useState } from "react";
import { Button } from "../button.js";
import { Checkbox } from "../checkbox.js";
import { Field, Input, Textarea } from "../field.js";
import type { Choice } from "../playbook/create-playbook-form.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../select.js";
import { Skeleton, StatusText } from "../status.js";

/** What the form decides; the page adds the document version and the surface. */
export type ReviewSettings = Omit<ReviewRequest, "document_version_id" | "surface" | "thread_id">;

type Paper = "ours" | "theirs";
type Mode = "standard" | "in_depth" | "redline_only";

const MODES: { value: Mode; label: string; hint: string }[] = [
  { value: "standard", label: "Standard", hint: "Each rule against the clauses it maps to." },
  {
    value: "in_depth",
    label: "In depth",
    hint: "Also reads the definitions a clause relies on. Slower.",
  },
  {
    value: "redline_only",
    label: "Redline only",
    hint: "Suggested edits for unacceptable clauses, with no narrative.",
  },
];

/**
 * The customise sheet before a review runs. The playbook and document pickers appear only
 * when the page hasn't fixed them, as from a vault file or a playbook's own page.
 */
export function CustomiseReviewForm({
  playbooks,
  playbookId,
  onPlaybookChange,
  documents,
  documentId,
  onDocumentChange,
  rules,
  pages,
  canUseDraft = false,
  busy = false,
  error,
  onSubmit,
  onCancel,
}: {
  /** Published playbooks to choose from; left out when the playbook is fixed. */
  playbooks?: readonly Choice[];
  playbookId: string | null;
  onPlaybookChange?: (id: string) => void;
  /** Documents to review; left out when the document is fixed. */
  documents?: readonly Choice[];
  documentId: string | null;
  onDocumentChange?: (id: string) => void;
  /** The chosen playbook's rules, or null while they load. */
  rules: readonly { id: string; title: string }[] | null;
  /** Page count or estimate of the chosen document, for the long-document warning. */
  pages?: number | null;
  /** The caller can edit the playbook, so may review against its unpublished draft. */
  canUseDraft?: boolean;
  busy?: boolean;
  error?: string | null;
  onSubmit: (settings: ReviewSettings, options: { draft: boolean }) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const [party, setParty] = useState("");
  const [paper, setPaper] = useState<Paper>("theirs");
  const [mode, setMode] = useState<Mode>("standard");
  const [everyRule, setEveryRule] = useState(true);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(() => new Set());
  const [jurisdiction, setJurisdiction] = useState("");
  const [context, setContext] = useState("");
  const [draft, setDraft] = useState(false);

  const place = jurisdiction.trim().toUpperCase();
  const placeOk = place === "" || Jurisdiction.safeParse(place).success;
  const scopeOk = everyRule || chosen.size > 0;
  const ready =
    playbookId !== null && documentId !== null && rules !== null && scopeOk && placeOk && !busy;

  const toggle = (ruleId: string, on: boolean) =>
    setChosen((ids) => {
      const next = new Set(ids);
      if (on) next.add(ruleId);
      else next.delete(ruleId);
      return next;
    });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!ready || !rules) return;
    const text = context.trim();
    onSubmit(
      {
        party: party.trim(),
        paper,
        mode,
        // Keep the playbook's order, whatever order the boxes were ticked in.
        scope: everyRule ? "all" : rules.filter((r) => chosen.has(r.id)).map((r) => r.id),
        ...(place ? { jurisdiction: place } : {}),
        ...(text ? { extra_context: { text, document_ids: [] } } : {}),
      },
      { draft },
    );
  };

  return (
    <form className="grid gap-4" onSubmit={submit} aria-busy={busy}>
      {playbooks && (
        <Picker
          label="Playbook"
          empty="No published playbooks yet. Publish one first."
          choices={playbooks}
          value={playbookId}
          onChange={onPlaybookChange}
        />
      )}
      {documents && (
        <Picker
          label="Contract"
          empty="Upload a contract first. It must finish processing before it can be reviewed."
          choices={documents}
          value={documentId}
          onChange={onDocumentChange}
        />
      )}
      {pages != null && pages >= PLAYBOOK_LIMITS.warn_pages && (
        <p role="note">
          <StatusText tone="warning">
            Reviews over 100 pages are slower and less accurate; consider running selected rules.
          </StatusText>
        </p>
      )}

      <Field label="Representing" hint="The party you act for, such as the customer.">
        {(props) => (
          <Input
            {...props}
            value={party}
            maxLength={200}
            onChange={(e) => setParty(e.target.value)}
          />
        )}
      </Field>

      <fieldset className="grid gap-1">
        <legend className="mb-1 text-ui font-medium">Whose paper</legend>
        <div className="flex gap-4">
          {(["theirs", "ours"] as const).map((value) => (
            <label key={value} className="flex items-center gap-2">
              <input
                type="radio"
                name={`${id}-paper`}
                value={value}
                checked={paper === value}
                onChange={() => setPaper(value)}
                className="accent-accent"
              />
              {value === "theirs" ? "Theirs" : "Ours"}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="grid gap-2">
        <legend className="mb-1 text-ui font-medium">Mode</legend>
        {MODES.map((m) => (
          <label
            key={m.value}
            className="flex cursor-pointer items-start gap-2 rounded-md border border-border p-2 has-checked:border-accent"
          >
            <input
              type="radio"
              name={`${id}-mode`}
              value={m.value}
              checked={mode === m.value}
              onChange={() => setMode(m.value)}
              className="mt-1 accent-accent"
            />
            <span className="grid">
              <span className="font-medium">{m.label}</span>
              <span className="text-caption text-fg-muted">{m.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <fieldset className="grid gap-2">
        <legend className="mb-1 text-ui font-medium">Rules</legend>
        <div className="flex gap-4">
          {[true, false].map((all) => (
            <label key={String(all)} className="flex items-center gap-2">
              <input
                type="radio"
                name={`${id}-scope`}
                checked={everyRule === all}
                onChange={() => setEveryRule(all)}
                className="accent-accent"
              />
              {all ? "All rules" : "Selected rules"}
            </label>
          ))}
        </div>
        {!everyRule &&
          (rules === null ? (
            <Skeleton className="h-16" />
          ) : (
            <ul className="grid max-h-60 gap-0.5 overflow-auto rounded-md border border-border p-2">
              {rules.map((rule) => {
                const box = `${id}-rule-${rule.id}`;
                return (
                  <li key={rule.id} className="flex items-center gap-1">
                    <Checkbox
                      id={box}
                      checked={chosen.has(rule.id)}
                      onCheckedChange={(on) => toggle(rule.id, on === true)}
                    />
                    <label htmlFor={box}>{rule.title}</label>
                  </li>
                );
              })}
            </ul>
          ))}
        {!scopeOk && <p className="text-caption text-fg-muted">Choose at least one rule.</p>}
      </fieldset>

      <Field
        label="Governing law"
        hint="Optional. A region code such as US, UK or US-CA; picks rules that depend on it."
        error={placeOk ? undefined : "Use a two-letter region code, such as UK or US-NY."}
      >
        {(props) => (
          <Input
            {...props}
            value={jurisdiction}
            maxLength={6}
            onChange={(e) => setJurisdiction(e.target.value)}
          />
        )}
      </Field>

      <Field
        label="Extra context"
        hint={`Optional. Deal background the review should know, up to ${PLAYBOOK_LIMITS.extra_context_chars.toLocaleString("en")} characters.`}
      >
        {(props) => (
          <Textarea
            {...props}
            value={context}
            maxLength={PLAYBOOK_LIMITS.extra_context_chars}
            onChange={(e) => setContext(e.target.value)}
          />
        )}
      </Field>

      {canUseDraft && (
        <div className="flex items-center gap-1">
          <Checkbox
            id={`${id}-draft`}
            checked={draft}
            onCheckedChange={(on) => setDraft(on === true)}
          />
          <label htmlFor={`${id}-draft`}>Use the latest unpublished version</label>
        </div>
      )}

      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" disabled={!ready}>
          {busy ? "Starting…" : "Run review"}
        </Button>
        <Button variant="quiet" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function Picker({
  label,
  empty,
  choices,
  value,
  onChange,
}: {
  label: string;
  empty: string;
  choices: readonly Choice[];
  value: string | null;
  onChange: ((id: string) => void) | undefined;
}) {
  if (choices.length === 0) return <p className="text-fg-muted">{empty}</p>;
  return (
    <Field label={label}>
      {(props) => (
        <Select value={value ?? ""} {...(onChange ? { onValueChange: onChange } : {})}>
          <SelectTrigger {...props}>
            <SelectValue placeholder="Choose one" />
          </SelectTrigger>
          <SelectContent>
            {choices.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </Field>
  );
}

export function CustomiseReviewFormSkeleton() {
  return (
    <div aria-busy="true" className="grid gap-3">
      <span className="sr-only">Loading…</span>
      <Skeleton className="h-12" />
      <Skeleton className="h-8" />
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="h-14" />
      ))}
      <Skeleton className="h-20" />
    </div>
  );
}
