import { Button, Field, Textarea, toast } from "@legallabs/ui";
import { useState } from "react";
import { messageOf } from "../api.js";
import { type Memory, memoryApi } from "./api.js";

export function CreateMemory({ onCreated }: { onCreated: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      await memoryApi.create(text.trim());
      setText("");
      onCreated();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="grid gap-2" aria-labelledby="create-heading">
      <h2 id="create-heading" className="text-section font-semibold">
        Create memory
      </h2>
      <Field
        label="New memory"
        hint="Up to 1,000 characters, e.g. I prefer British spelling."
        error={error}
      >
        {(props) => (
          <Textarea {...props} rows={3} value={text} onChange={(e) => setText(e.target.value)} />
        )}
      </Field>
      <Button className="justify-self-start" disabled={busy || !text.trim()} onClick={add}>
        Add memory
      </Button>
    </section>
  );
}

export function MemoryRow({
  memory,
  conflict,
  onChanged,
}: {
  memory: Memory;
  conflict: boolean;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(memory.text);
  const fail = (err: unknown) => toast.error(messageOf(err));
  if (editing) {
    return (
      <li className="grid gap-2 rounded-md border border-border p-3">
        <Textarea
          aria-label="Memory text"
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="flex gap-2">
          <Button
            size="sm"
            disabled={!text.trim()}
            onClick={() =>
              memoryApi.update(memory.id, text.trim()).then(() => {
                setEditing(false);
                onChanged();
              }, fail)
            }
          >
            Save
          </Button>
          <Button size="sm" variant="quiet" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </div>
      </li>
    );
  }
  return (
    <li className="grid gap-1 rounded-md border border-border p-3">
      <p>{memory.text}</p>
      <div className="flex flex-wrap items-center gap-2 text-caption text-fg-muted">
        <span>{memory.source}</span>
        {conflict && (
          <>
            <span role="status" className="text-destructive">
              Conflicts with another memory
            </span>
            <Button
              size="sm"
              variant="secondary"
              aria-label={`Resolve: ${memory.text}`}
              onClick={() => setEditing(true)}
            >
              Resolve
            </Button>
          </>
        )}
        <span className="ml-auto flex gap-1">
          <Button
            size="sm"
            variant="quiet"
            aria-label={`Edit: ${memory.text}`}
            onClick={() => setEditing(true)}
          >
            Edit
          </Button>
          <Button
            size="sm"
            variant="quiet"
            aria-label={`Delete: ${memory.text}`}
            onClick={() => memoryApi.remove(memory.id).then(onChanged, fail)}
          >
            Delete
          </Button>
        </span>
      </div>
    </li>
  );
}
