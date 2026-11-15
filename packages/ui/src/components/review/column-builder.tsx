import { type FormEvent, useState } from "react";
import { Button } from "../button.js";
import { Checkbox } from "../checkbox.js";
import { Field, Input, Textarea } from "../field.js";
import { SidePanel } from "../side-panel.js";
import { Skeleton } from "../status.js";
import { type NewColumn, TYPE_NAMES } from "./presets.js";

type Proposal = NewColumn & { picked: boolean; key: string };

/** Describe a review, get proposed columns, tick the ones to add (UX §5.5). */
export function ColumnBuilder({
  onGenerate,
  onAdd,
  onClose,
  instructions,
  width = 420,
  onWidthChange,
}: {
  onGenerate: (description: string) => Promise<NewColumn[]>;
  onAdd: (columns: NewColumn[]) => Promise<void> | void;
  onClose: () => void;
  instructions?: string;
  width?: number;
  onWidthChange?: (width: number) => void;
}) {
  const [description, setDescription] = useState("");
  const [proposals, setProposals] = useState<Proposal[] | null>(null);
  const [busy, setBusy] = useState<"generate" | "add" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const picked = proposals?.filter((p) => p.picked) ?? [];

  const generate = async (event: FormEvent) => {
    event.preventDefault();
    if (description.trim().length < 3) {
      setError("Describe the review in a few words.");
      return;
    }
    setBusy("generate");
    setError(null);
    try {
      const result = await onGenerate(description.trim());
      setProposals(result.map((p, i) => ({ ...p, picked: true, key: `${Date.now()}-${i}` })));
      if (result.length === 0) setError("No columns came back. Try describing it differently.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't propose columns. Try again.");
    } finally {
      setBusy(null);
    }
  };

  const add = async () => {
    setBusy("add");
    setError(null);
    try {
      await onAdd(picked.map(({ picked: _, key: __, ...column }) => column));
      setProposals(null);
      setDescription("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't add the columns. Try again.");
    } finally {
      setBusy(null);
    }
  };

  const update = (i: number, patch: Partial<Proposal>) =>
    setProposals((list) => list?.map((p, j) => (j === i ? { ...p, ...patch } : p)) ?? null);

  return (
    <SidePanel
      title="Column builder"
      onClose={onClose}
      width={width}
      {...(onWidthChange ? { onWidthChange } : {})}
    >
      <div className="grid gap-4">
        {instructions && (
          <details className="rounded-md border border-border p-2 text-dense">
            <summary className="cursor-pointer text-fg-muted">Table instructions</summary>
            <p className="mt-1 whitespace-pre-wrap">{instructions}</p>
          </details>
        )}
        <form onSubmit={generate} className="grid gap-2">
          <Field label="What should the table capture?">
            {(props) => (
              <Textarea
                {...props}
                rows={3}
                maxLength={2000}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Key economic terms of a lease"
              />
            )}
          </Field>
          <Button type="submit" variant="secondary" disabled={busy !== null}>
            {busy === "generate" ? "Proposing columns…" : "Generate columns"}
          </Button>
        </form>
        {error && (
          <p role="alert" className="text-caption text-destructive">
            {error}
          </p>
        )}
        {busy === "generate" && (
          <div aria-hidden className="grid gap-2">
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
          </div>
        )}
        {proposals && proposals.length > 0 && (
          <section aria-label="Proposed columns" className="grid gap-2">
            <ul className="grid gap-2">
              {proposals.map((p, i) => (
                <li
                  key={`${i}-${p.type}`}
                  className="flex gap-2 rounded-md border border-border p-2"
                >
                  <Checkbox
                    checked={p.picked}
                    onCheckedChange={(value) => update(i, { picked: value === true })}
                    aria-label={`Add ${p.label}`}
                  />
                  <div className="grid min-w-0 flex-1 gap-1">
                    <div className="flex items-center gap-2">
                      <Input
                        aria-label={`Name of column ${i + 1}`}
                        value={p.label}
                        maxLength={80}
                        onChange={(e) => update(i, { label: e.target.value })}
                        className="h-7"
                      />
                      <span className="shrink-0 text-caption text-fg-muted">
                        {TYPE_NAMES[p.type]}
                      </span>
                    </div>
                    <p className="text-caption text-fg-muted">{p.prompt}</p>
                  </div>
                </li>
              ))}
            </ul>
            <Button onClick={add} disabled={picked.length === 0 || busy !== null}>
              {busy === "add"
                ? "Adding…"
                : `Add ${picked.length} column${picked.length === 1 ? "" : "s"}`}
            </Button>
          </section>
        )}
      </div>
    </SidePanel>
  );
}
