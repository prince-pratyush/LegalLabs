import { fillPrompt, promptVariables } from "@legallabs/contracts";
import { type FormEvent, useState } from "react";
import { Button } from "../button.js";
import { Field, Input } from "../field.js";
import { Skeleton } from "../status.js";

/** Asks for a saved prompt's {{variables}}, shows the result, then hands it to the composer. */
export function PromptFill({
  text,
  onUse,
  onCancel,
}: {
  text: string;
  onUse: (filled: string) => void;
  onCancel: () => void;
}) {
  const names = promptVariables(text);
  const [values, setValues] = useState<Record<string, string>>({});
  const filled = fillPrompt(text, values);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onUse(filled);
  };
  return (
    <form className="grid gap-4" onSubmit={submit}>
      {names.length > 0 && (
        <fieldset className="grid gap-3">
          <legend className="mb-1 text-dense text-fg-muted">
            Fill in the blanks. Anything left empty stays as a placeholder you can edit.
          </legend>
          {names.map((name) => (
            <Field key={name} label={name}>
              {(props) => (
                <Input
                  {...props}
                  value={values[name] ?? ""}
                  onChange={(e) => setValues((v) => ({ ...v, [name]: e.target.value }))}
                  maxLength={500}
                />
              )}
            </Field>
          ))}
        </fieldset>
      )}
      <section aria-label="Prompt to send" className="grid gap-1">
        <h3 className="text-dense font-semibold">Prompt</h3>
        <p className="max-h-64 overflow-auto rounded-md border border-border bg-surface p-3 text-dense whitespace-pre-wrap">
          {filled}
        </p>
      </section>
      <div className="flex gap-2">
        <Button type="submit">Use in a thread</Button>
        <Button type="button" variant="quiet" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export function PromptFillSkeleton() {
  return (
    <div role="status" aria-label="Loading the prompt" className="grid gap-3">
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-24 w-full" />
    </div>
  );
}
