import { Plus } from "lucide-react";
import { type FormEvent, useState } from "react";
import { cn } from "../../cn.js";
import { Button } from "../button.js";
import { Field, Input, Textarea } from "../field.js";
import { Popover, PopoverContent, PopoverTrigger } from "../popover.js";
import { columnProblem, type NewColumn, PRESETS, type PresetId, presetColumn } from "./presets.js";

/** The add-column form: pick a friendly type, name it, say what to look for. */
export function AddColumnForm({
  onAdd,
  busy = false,
  error,
}: {
  onAdd: (column: NewColumn) => void;
  busy?: boolean;
  error?: string | null;
}) {
  const [preset, setPreset] = useState<PresetId>("text");
  const [label, setLabel] = useState("");
  const [prompt, setPrompt] = useState("");
  const [labels, setLabels] = useState("");
  const [tried, setTried] = useState(false);
  const list = labels.split(",");
  const problem = columnProblem(preset, label, prompt, list);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTried(true);
    if (!problem) onAdd(presetColumn(preset, label, prompt, list));
  };

  return (
    <form onSubmit={submit} className="grid gap-3" aria-label="Add column">
      <fieldset className="grid gap-1">
        <legend className="mb-1 text-ui font-medium">Type</legend>
        <div className="grid grid-cols-4 gap-1">
          {PRESETS.map((p) => (
            <label
              key={p.id}
              title={p.hint}
              className={cn(
                "flex h-8 cursor-pointer items-center justify-center rounded-md border border-border text-dense has-checked:border-accent has-checked:tint-selected has-focus-visible:outline-2 has-focus-visible:outline-accent",
              )}
            >
              <input
                type="radio"
                name="preset"
                value={p.id}
                checked={preset === p.id}
                onChange={() => setPreset(p.id)}
                className="sr-only"
              />
              {p.name}
            </label>
          ))}
        </div>
        <p className="text-caption text-fg-muted">{PRESETS.find((p) => p.id === preset)?.hint}</p>
      </fieldset>
      <Field label="Column name">
        {(props) => (
          <Input
            {...props}
            value={label}
            maxLength={80}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Governing law"
          />
        )}
      </Field>
      {preset !== "manual" && (
        <Field label="What to look for" hint="Asked of each document on its own.">
          {(props) => (
            <Textarea
              {...props}
              value={prompt}
              rows={3}
              maxLength={4000}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Which law governs this agreement?"
            />
          )}
        </Field>
      )}
      {preset === "list" && (
        <Field label="Labels" hint="Separate with commas, 2 to 20.">
          {(props) => (
            <Input
              {...props}
              value={labels}
              onChange={(e) => setLabels(e.target.value)}
              placeholder="Assignment, Change of control, Termination"
            />
          )}
        </Field>
      )}
      {((tried && problem) || error) && (
        <p role="alert" className="text-caption text-destructive">
          {(tried && problem) || error}
        </p>
      )}
      <div className="flex justify-end">
        <Button type="submit" disabled={busy}>
          {busy ? "Adding…" : "Add column"}
        </Button>
      </div>
    </form>
  );
}

/** "+ Column" with the form in a popover. */
export function AddColumnPopover({
  open,
  onOpenChange,
  ...props
}: Parameters<typeof AddColumnForm>[0] & { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button variant="secondary">
          <Plus aria-hidden />
          Column
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" aria-label="New column" className="w-96">
        <AddColumnForm {...props} />
      </PopoverContent>
    </Popover>
  );
}
