import type { PlaybookCreate, StarterTemplate } from "@legallabs/contracts";
import { type FormEvent, useId, useState } from "react";
import { Button } from "../button.js";
import { Field, Input } from "../field.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../select.js";
import { Skeleton } from "../status.js";

type Source = PlaybookCreate["source"]["kind"];
export interface Choice {
  id: string;
  name: string;
}

const SOURCES: { kind: Source; label: string; hint: string }[] = [
  { kind: "scratch", label: "Start from scratch", hint: "An empty playbook you fill in." },
  {
    kind: "starter",
    label: "Start from a template",
    hint: "Customer-side NDA or MSA positions to adapt.",
  },
  { kind: "playbook", label: "Copy a playbook", hint: "A new copy of one you can already see." },
  {
    kind: "document",
    label: "From an example contract",
    hint: "Drafts rules from a contract you accepted. Check each one before publishing.",
  },
];

const TEMPLATES: Record<StarterTemplate, { label: string; type: string }> = {
  nda: { label: "Non-disclosure agreement", type: "NDA" },
  msa: { label: "Master services agreement", type: "MSA" },
};

/** The choices for a new playbook; the panel around it is the page's. */
export function CreatePlaybookForm({
  playbooks,
  documents,
  busy = false,
  error,
  onSubmit,
  onCancel,
}: {
  /** Playbooks the caller can copy. */
  playbooks: readonly Choice[];
  /** Readable documents that have finished processing. */
  documents: readonly Choice[];
  busy?: boolean;
  error?: string | null;
  onSubmit: (input: PlaybookCreate) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const [kind, setKind] = useState<Source>("scratch");
  const [template, setTemplate] = useState<StarterTemplate>("nda");
  const [playbookId, setPlaybookId] = useState("");
  const [documentId, setDocumentId] = useState("");
  const [name, setName] = useState("");
  const [contractType, setContractType] = useState("");

  const source = (): PlaybookCreate["source"] | null => {
    switch (kind) {
      case "scratch":
        return { kind, rules: [] };
      case "starter":
        return { kind, template };
      case "playbook":
        return playbookId ? { kind, playbook_id: playbookId } : null;
      case "document":
        return documentId ? { kind, document_id: documentId } : null;
    }
  };
  const ready = name.trim() !== "" && contractType.trim() !== "" && source() !== null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const chosen = source();
    if (!chosen || !ready) return;
    onSubmit({ name: name.trim(), contract_type: contractType.trim(), source: chosen });
  };

  return (
    <form className="grid gap-4" onSubmit={submit} aria-busy={busy}>
      <fieldset className="grid gap-2">
        <legend className="mb-1 text-ui font-medium">Start from</legend>
        {SOURCES.map((s) => (
          <label
            key={s.kind}
            className="flex cursor-pointer items-start gap-2 rounded-md border border-border p-2 has-checked:border-accent"
          >
            <input
              type="radio"
              name={`${id}-source`}
              value={s.kind}
              checked={kind === s.kind}
              onChange={() => setKind(s.kind)}
              className="mt-1 accent-accent"
            />
            <span className="grid">
              <span className="font-medium">{s.label}</span>
              <span className="text-caption text-fg-muted">{s.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>

      {kind === "starter" && (
        <Field label="Template">
          {(props) => (
            <Select
              value={template}
              onValueChange={(value) => {
                const next = value as StarterTemplate;
                setTemplate(next);
                if (!contractType.trim()) setContractType(TEMPLATES[next].type);
              }}
            >
              <SelectTrigger {...props}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(TEMPLATES).map(([value, t]) => (
                  <SelectItem key={value} value={value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </Field>
      )}
      {kind === "playbook" && (
        <Picker
          label="Playbook to copy"
          empty="There are no playbooks to copy yet."
          choices={playbooks}
          value={playbookId}
          onChange={setPlaybookId}
        />
      )}
      {kind === "document" && (
        <Picker
          label="Example contract"
          empty="Upload a contract first. It must finish processing before it can be used."
          choices={documents}
          value={documentId}
          onChange={setDocumentId}
        />
      )}

      <Field label="Name">
        {(props) => (
          <Input
            {...props}
            value={name}
            maxLength={200}
            onChange={(e) => setName(e.target.value)}
            required
          />
        )}
      </Field>
      <Field label="Contract type" hint="Such as NDA, MSA or DPA.">
        {(props) => (
          <Input
            {...props}
            value={contractType}
            maxLength={100}
            onChange={(e) => setContractType(e.target.value)}
            required
          />
        )}
      </Field>

      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {busy && kind === "document" && (
        <p role="status" className="text-fg-muted">
          Reading the contract and drafting rules. This can take a minute or two.
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" disabled={!ready || busy}>
          {busy ? "Creating…" : "Create playbook"}
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
  value: string;
  onChange: (id: string) => void;
}) {
  if (choices.length === 0) return <p className="text-fg-muted">{empty}</p>;
  return (
    <Field label={label}>
      {(props) => (
        <Select value={value} onValueChange={onChange}>
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

export function CreatePlaybookFormSkeleton() {
  return (
    <div aria-busy="true" className="grid gap-3">
      <span className="sr-only">Loading…</span>
      {[0, 1, 2, 3].map((i) => (
        <Skeleton key={i} className="h-12" />
      ))}
      <Skeleton className="h-14" />
      <Skeleton className="h-14" />
    </div>
  );
}
