import { INTAKE_LIMITS, IntakeFieldType } from "@legallabs/contracts";
import {
  Button,
  Checkbox,
  ConfirmDialog,
  EmptyState,
  Field,
  Input,
  NativeSelect,
  Skeleton,
  Textarea,
} from "@legallabs/ui";
import { type FormEvent, useEffect, useId, useState } from "react";
import { messageOf } from "../api.js";
import { intakeApi } from "./api.js";
import { BLANK, type FieldDraft, type TypeDraft, toDraft, toInput } from "./form.js";
import { goIntake } from "./route.js";

const KIND: Record<IntakeFieldType, string> = {
  text: "Text",
  select: "Choice",
  date: "Date",
  money: "Amount",
  file: "File",
  matter: "Matter",
  boolean: "Yes or no",
};

function FieldRow({
  field,
  onChange,
  onRemove,
}: {
  field: FieldDraft;
  onChange: (patch: Partial<FieldDraft>) => void;
  onRemove: () => void;
}) {
  const required = useId();
  return (
    <li className="grid gap-2 rounded-md border border-border p-3">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Field label" className="min-w-48 flex-1">
          {(props) => (
            <Input
              {...props}
              value={field.label}
              maxLength={200}
              onChange={(e) => onChange({ label: e.target.value })}
            />
          )}
        </Field>
        <Field label="Field kind">
          {(props) => (
            <NativeSelect
              {...props}
              value={field.type}
              onChange={(e) => onChange({ type: e.target.value as IntakeFieldType })}
            >
              {IntakeFieldType.options.map((kind) => (
                <option key={kind} value={kind}>
                  {KIND[kind]}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
        <label htmlFor={required} className="flex h-8 items-center gap-1">
          <Checkbox
            id={required}
            checked={field.required}
            onCheckedChange={(on) => onChange({ required: on === true })}
          />
          Required
        </label>
        <Button variant="quiet" size="sm" onClick={onRemove}>
          Remove field
        </Button>
      </div>
      {field.type === "select" && (
        <Field label="Choices, one per line">
          {(props) => (
            <Textarea
              {...props}
              value={field.options}
              onChange={(e) => onChange({ options: e.target.value })}
            />
          )}
        </Field>
      )}
      <Field label="How to ask the requester for it">
        {(props) => (
          <Input
            {...props}
            value={field.prompt}
            maxLength={500}
            onChange={(e) => onChange({ prompt: e.target.value })}
          />
        )}
      </Field>
    </li>
  );
}

/**
 * Creates or edits a request type. Routing and escalations are not edited here, so saving
 * leaves whatever the type already has.
 */
export function TypePage({ typeId }: { typeId: string | null }) {
  const [draft, setDraft] = useState<TypeDraft | null>(typeId ? null : BLANK);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!typeId) return;
    intakeApi.types().then(
      ({ types }) => {
        const found = types.find((t) => t.id === typeId);
        if (found) setDraft(toDraft(found));
        else setMissing(true);
      },
      (err) => setError(messageOf(err)),
    );
  }, [typeId]);

  const back = () => goIntake({ page: "types" });

  if (missing) {
    return (
      <EmptyState
        title="Request type not found"
        description="It may have been removed."
        action={{ label: "Back to request types", onClick: back }}
      />
    );
  }
  if (!draft) {
    return error ? (
      <p role="alert" className="text-destructive">
        {error}
      </p>
    ) : (
      <Skeleton className="h-24 max-w-2xl" />
    );
  }

  const set = (patch: Partial<TypeDraft>) => setDraft((d) => d && { ...d, ...patch });
  const setField = (row: number, patch: Partial<FieldDraft>) =>
    setDraft(
      (d) => d && { ...d, fields: d.fields.map((f) => (f.row === row ? { ...f, ...patch } : f)) },
    );
  const addField = () =>
    set({
      fields: [
        ...draft.fields,
        {
          row: Math.max(-1, ...draft.fields.map((f) => f.row)) + 1,
          key: "",
          label: "",
          type: "text",
          required: false,
          options: "",
          prompt: "",
        },
      ],
    });

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      back();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  const save = (e: FormEvent) => {
    e.preventDefault();
    const input = toInput(draft);
    if (typeof input === "string") return setError(input);
    run(() => (typeId ? intakeApi.updateType(typeId, input) : intakeApi.createType(input)));
  };

  return (
    <form className="grid max-w-2xl content-start gap-4" onSubmit={save} noValidate>
      <h1 className="text-title font-semibold">
        {typeId ? "Edit request type" : "New request type"}
      </h1>
      <Field label="Name">
        {(props) => (
          <Input
            {...props}
            value={draft.name}
            maxLength={100}
            onChange={(e) => set({ name: e.target.value })}
          />
        )}
      </Field>
      <Field label="Description">
        {(props) => (
          <Textarea
            {...props}
            value={draft.description}
            maxLength={1000}
            onChange={(e) => set({ description: e.target.value })}
          />
        )}
      </Field>
      <div className="flex flex-wrap gap-3">
        <Field label="Hours to resolve">
          {(props) => (
            <Input
              {...props}
              type="number"
              min={1}
              max={720}
              value={draft.sla}
              onChange={(e) => set({ sla: e.target.value })}
            />
          )}
        </Field>
        <Field label="Hours to wait for a requester">
          {(props) => (
            <Input
              {...props}
              type="number"
              min={1}
              max={720}
              value={draft.timeout}
              onChange={(e) => set({ timeout: e.target.value })}
            />
          )}
        </Field>
      </div>
      <section aria-label="Fields" className="grid gap-2">
        <h2 className="text-section font-semibold">Fields</h2>
        <ul className="grid gap-2">
          {draft.fields.map((f) => (
            <FieldRow
              key={f.row}
              field={f}
              onChange={(patch) => setField(f.row, patch)}
              onRemove={() => set({ fields: draft.fields.filter((x) => x.row !== f.row) })}
            />
          ))}
        </ul>
        {draft.fields.length < INTAKE_LIMITS.fields && (
          <Button variant="secondary" size="sm" className="justify-self-start" onClick={addField}>
            Add field
          </Button>
        )}
      </section>
      <Field label="Keywords that pick this type, one per line">
        {(props) => (
          <Textarea
            {...props}
            value={draft.keywords}
            onChange={(e) => set({ keywords: e.target.value })}
          />
        )}
      </Field>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy}>
          Save
        </Button>
        <Button variant="quiet" onClick={back}>
          Cancel
        </Button>
        {typeId && (
          <span className="ml-auto">
            <ConfirmDialog
              trigger={
                <Button variant="destructive" disabled={busy}>
                  Remove type
                </Button>
              }
              title="Remove this request type?"
              description="Requests already made keep its name. New ones can't use it."
              confirmLabel="Remove"
              destructive
              onConfirm={() => run(() => intakeApi.removeType(typeId))}
            />
          </span>
        )}
      </div>
    </form>
  );
}
