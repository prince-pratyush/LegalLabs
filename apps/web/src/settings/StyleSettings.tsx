import { Button, Checkbox, ConfirmDialog, Field, Input, Textarea, toast } from "@legallabs/ui";
import { useCallback, useEffect, useState } from "react";
import { messageOf } from "../api.js";
import { stylesApi, type WritingStyle } from "./api.js";

/** Writing styles you make, and the ones your workspace shares. */
export function StyleSettings() {
  const [styles, setStyles] = useState<{ mine: WritingStyle[]; workspace: WritingStyle[] } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    stylesApi.list().then(setStyles, (err) => setError(messageOf(err)));
  }, []);
  useEffect(refresh, [refresh]);

  if (error && !styles) return <p role="alert">{error}</p>;
  if (!styles) return <p role="status">Loading writing styles</p>;

  return (
    <div className="grid max-w-3xl gap-8">
      <CreateStyle onCreated={refresh} />
      <section className="grid gap-3" aria-labelledby="mine-heading">
        <h2 id="mine-heading" className="text-section font-semibold">
          Your styles
        </h2>
        {styles.mine.length === 0 ? (
          <p className="text-fg-muted">No writing styles yet.</p>
        ) : (
          <ul className="grid gap-3" aria-label="Your writing styles">
            {styles.mine.map((s) => (
              <StyleRow key={s.id} style={s} onChanged={refresh} />
            ))}
          </ul>
        )}
      </section>
      <section className="grid gap-3" aria-labelledby="workspace-heading">
        <h2 id="workspace-heading" className="text-section font-semibold">
          Workspace
        </h2>
        {styles.workspace.length === 0 ? (
          <p className="text-fg-muted">Nobody has shared a writing style with the workspace.</p>
        ) : (
          <ul className="grid gap-3" aria-label="Workspace writing styles">
            {styles.workspace.map((s) => (
              <li key={s.id} className="grid gap-1 rounded-md border border-border p-3">
                <span className="text-ui font-medium">{s.name}</span>
                <span className="text-caption text-fg-muted">
                  Shared by {s.owner_name}; read only
                </span>
                {(s.derived_instructions ?? s.instructions) && (
                  <p className="whitespace-pre-wrap text-dense">
                    {s.derived_instructions ?? s.instructions}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function CreateStyle({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState("");
  const [mode, setMode] = useState<"instructions" | "sample">("instructions");
  const [instructions, setInstructions] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready = name.trim() && (mode === "instructions" ? instructions.trim() : file);
  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      if (mode === "sample" && file) await stylesApi.createFromSample(name.trim(), file);
      else await stylesApi.createFromInstructions(name.trim(), instructions.trim());
      setName("");
      setInstructions("");
      setFile(null);
      toast.success("Writing style created.");
      onCreated();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="grid gap-3" aria-labelledby="create-style-heading">
      <h2 id="create-style-heading" className="text-section font-semibold">
        Create writing style
      </h2>
      <Field label="Style name">
        {(props) => (
          <Input {...props} maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
        )}
      </Field>
      <fieldset className="flex gap-4">
        <legend className="sr-only">How to describe the style</legend>
        <label className="flex items-center gap-2 text-ui">
          <input
            type="radio"
            name="style-mode"
            checked={mode === "instructions"}
            onChange={() => setMode("instructions")}
          />
          Write instructions
        </label>
        <label className="flex items-center gap-2 text-ui">
          <input
            type="radio"
            name="style-mode"
            checked={mode === "sample"}
            onChange={() => setMode("sample")}
          />
          Learn from a sample file
        </label>
      </fieldset>
      {mode === "instructions" ? (
        <Field
          label="Instructions"
          hint="Up to 5,000 characters, e.g. Plain English, short sentences, no Latin."
        >
          {(props) => (
            <Textarea
              {...props}
              rows={5}
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
            />
          )}
        </Field>
      ) : (
        <Field
          label="Sample file"
          hint="A PDF or Word file of up to 20 pages. We read it once to describe its style."
        >
          {(props) => (
            <Input
              {...props}
              type="file"
              accept=".pdf,.docx"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          )}
        </Field>
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <Button className="justify-self-start" disabled={busy || !ready} onClick={create}>
        Create style
      </Button>
    </section>
  );
}

function StyleRow({ style, onChanged }: { style: WritingStyle; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const editable = style.kind === "sample" ? style.derived_instructions : style.instructions;
  const [text, setText] = useState(editable ?? "");
  const [shareError, setShareError] = useState<string | null>(null);
  const fail = (err: unknown) => toast.error(messageOf(err));

  const save = () =>
    stylesApi
      .update(
        style.id,
        style.kind === "sample"
          ? { derived_instructions: text.trim() }
          : { instructions: text.trim() },
      )
      .then(() => {
        setEditing(false);
        onChanged();
      }, fail);

  const share = (shared: boolean) =>
    // A 403 means this person can't share with the workspace; the server says why.
    stylesApi.share(style.id, shared).then(
      () => {
        setShareError(null);
        onChanged();
      },
      (err) => setShareError(messageOf(err)),
    );

  return (
    <li className="grid gap-2 rounded-md border border-border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-ui font-medium">{style.name}</span>
        <span className="text-caption text-fg-muted">
          {style.kind === "sample" ? "From a sample" : "Instructions"}
          {style.status === "processing" ? " · reading the sample" : ""}
          {style.status === "failed" ? " · couldn't read the sample" : ""}
        </span>
      </div>
      {editing ? (
        <div className="grid gap-2">
          <Textarea
            aria-label={`Instructions for ${style.name}`}
            rows={6}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="flex gap-2">
            <Button size="sm" disabled={!text.trim()} onClick={save}>
              Save
            </Button>
            <Button size="sm" variant="quiet" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        editable && <p className="whitespace-pre-wrap text-dense">{editable}</p>
      )}
      {shareError && (
        <p role="alert" className="text-dense text-destructive">
          {shareError}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex items-center gap-2 text-dense">
          <Checkbox
            aria-label={`Share ${style.name} with the workspace`}
            checked={style.shared}
            onCheckedChange={(v) => share(v === true)}
          />
          Share with workspace
        </span>
        <span className="ml-auto flex gap-1">
          {!editing && (
            <Button
              size="sm"
              variant="quiet"
              aria-label={`Edit: ${style.name}`}
              disabled={!editable}
              onClick={() => {
                setText(editable ?? "");
                setEditing(true);
              }}
            >
              Edit
            </Button>
          )}
          <ConfirmDialog
            trigger={
              <Button size="sm" variant="quiet" aria-label={`Delete: ${style.name}`}>
                Delete
              </Button>
            }
            title={`Delete ${style.name}?`}
            description="Past answers keep their record of using it, but nobody can pick it again."
            confirmLabel="Delete style"
            destructive
            onConfirm={() => stylesApi.remove(style.id).then(onChanged, fail)}
          />
        </span>
      </div>
    </li>
  );
}
