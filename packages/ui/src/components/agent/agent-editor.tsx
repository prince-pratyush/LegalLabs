import { AGENT_LIMITS } from "@legallabs/contracts";
import { Paperclip, Plus, TriangleAlert, Upload, X } from "lucide-react";
import { type FormEvent, useId, useRef, useState } from "react";
import { Button } from "../button.js";
import { Input, Label, Textarea } from "../field.js";
import { Skeleton } from "../status.js";
import {
  type AgentAttachmentItem,
  type AgentContent,
  type AgentSourceItem,
  type AttachChoice,
  KIND_LABEL,
  LABEL_PATTERN,
  type SourceChoice,
  selectStyles,
  toLabel,
  unresolvedLabels,
} from "./types.js";

const MAX_ATTACHMENTS = AGENT_LIMITS.attachments;
const MAX_SOURCES = AGENT_LIMITS.sources;
const MAX_CHARS = AGENT_LIMITS.instructions;

const taken = (content: AgentContent, label: string) =>
  [...content.attachments, ...content.sources].some(
    (x) => x.label.toLowerCase() === label.trim().toLowerCase(),
  );

/**
 * Instructions, attachments and sources. `@Label` in the instructions names an attachment
 * or source; a name with nothing behind it becomes a slot to attach something to.
 */
export function AgentEditor({
  value,
  onChange,
  attachChoices,
  sourceChoices,
  onUpload,
  onSave,
  hasLive,
  busy = false,
  dirty = false,
  error,
  readOnly = false,
}: {
  value: AgentContent;
  onChange: (next: AgentContent) => void;
  attachChoices: readonly AttachChoice[];
  sourceChoices: readonly SourceChoice[];
  /** Stores a file and gives it back as something to attach. */
  onUpload?: (file: File) => Promise<AttachChoice>;
  /** `promote` makes the saved version live; otherwise it is kept as the draft. */
  onSave: (promote: boolean) => void;
  /** Whether a live version exists, which a draft save leaves alone. */
  hasLive: boolean;
  busy?: boolean;
  dirty?: boolean;
  error?: string | null;
  readOnly?: boolean;
}) {
  const instructionsId = useId();
  const countId = useId();
  const [picking, setPicking] = useState<{ what: "attachment" | "source"; label: string } | null>(
    null,
  );
  const missing = unresolvedLabels(value);
  const fullAttachments = value.attachments.length >= MAX_ATTACHMENTS;
  const fullSources = value.sources.length >= MAX_SOURCES;

  const addAttachment = (item: AgentAttachmentItem) => {
    onChange({ ...value, attachments: [...value.attachments, item] });
    setPicking(null);
  };
  const addSource = (item: AgentSourceItem) => {
    onChange({ ...value, sources: [...value.sources, item] });
    setPicking(null);
  };

  return (
    <div className="grid gap-5">
      <div className="grid gap-1">
        <Label htmlFor={instructionsId}>Instructions</Label>
        <Textarea
          id={instructionsId}
          aria-describedby={countId}
          value={value.instructions}
          readOnly={readOnly}
          maxLength={MAX_CHARS}
          onChange={(e) => onChange({ ...value, instructions: e.target.value })}
          placeholder="Describe what the agent does, step by step. Name attachments as @Label."
          className="min-h-64 font-mono text-dense"
        />
        <p id={countId} className="text-caption text-fg-muted tabular-nums">
          Markdown · {value.instructions.length.toLocaleString("en-US")} of{" "}
          {MAX_CHARS.toLocaleString("en-US")} characters
        </p>
      </div>

      {missing.length > 0 && (
        <section
          aria-label="Unresolved names"
          className="grid gap-2 rounded-md border border-warning/40 p-3"
        >
          <p className="flex items-center gap-1.5 text-dense text-warning">
            <TriangleAlert aria-hidden className="size-4" strokeWidth={1.5} />
            {missing.length === 1
              ? "1 name in the instructions has nothing attached."
              : `${missing.length} names in the instructions have nothing attached.`}{" "}
            You can still save.
          </p>
          <ul className="flex flex-wrap gap-2">
            {missing.map((label) => (
              <li
                key={label}
                className="inline-flex items-center gap-2 rounded-md border border-dashed border-border px-2 py-1"
              >
                <span className="text-dense font-medium">@{label}</span>
                {!readOnly && (
                  <Button
                    size="sm"
                    variant="secondary"
                    aria-label={`Attach @${label}`}
                    disabled={fullAttachments}
                    onClick={() => setPicking({ what: "attachment", label })}
                  >
                    <Paperclip aria-hidden />
                    Attach
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby={`${countId}-files`} className="grid gap-2">
        <header className="flex items-center justify-between gap-2">
          <h3 id={`${countId}-files`} className="text-ui font-semibold">
            Attached files{" "}
            <span className="font-normal text-fg-muted tabular-nums">
              {value.attachments.length} of {MAX_ATTACHMENTS}
            </span>
          </h3>
          {!readOnly && (
            <Button
              size="sm"
              variant="quiet"
              disabled={fullAttachments}
              onClick={() => setPicking({ what: "attachment", label: "" })}
            >
              <Plus aria-hidden />
              Add file
            </Button>
          )}
        </header>
        {fullAttachments && !readOnly && (
          <p className="text-caption text-fg-muted">
            An agent can hold up to {MAX_ATTACHMENTS} attachments. Remove one to add another.
          </p>
        )}
        <ItemList
          empty="Nothing attached."
          readOnly={readOnly}
          items={value.attachments.map((a) => ({
            key: `${a.kind}:${a.ref}`,
            label: a.label,
            detail: `${KIND_LABEL[a.kind]} · ${a.name}`,
          }))}
          onRemove={(i) =>
            onChange({ ...value, attachments: value.attachments.filter((_, n) => n !== i) })
          }
        />
        {picking?.what === "attachment" && (
          <AttachmentPicker
            choices={attachChoices}
            initialLabel={picking.label}
            isTaken={(label) => taken(value, label)}
            {...(onUpload ? { onUpload } : {})}
            onAdd={addAttachment}
            onCancel={() => setPicking(null)}
          />
        )}
      </section>

      <section aria-labelledby={`${countId}-sources`} className="grid gap-2">
        <header className="flex items-center justify-between gap-2">
          <h3 id={`${countId}-sources`} className="text-ui font-semibold">
            Sources{" "}
            <span className="font-normal text-fg-muted tabular-nums">
              {value.sources.length} of {MAX_SOURCES}
            </span>
          </h3>
          {!readOnly && (
            <Button
              size="sm"
              variant="quiet"
              disabled={fullSources || sourceChoices.length === 0}
              onClick={() => setPicking({ what: "source", label: "" })}
            >
              <Plus aria-hidden />
              Add source
            </Button>
          )}
        </header>
        {fullSources && !readOnly && (
          <p className="text-caption text-fg-muted">
            An agent can use up to {MAX_SOURCES} sources.
          </p>
        )}
        <ItemList
          empty="No sources."
          readOnly={readOnly}
          items={value.sources.map((s) => ({
            key: `${s.kind}:${s.source}`,
            label: s.label,
            detail: `${KIND_LABEL[s.kind]} · ${s.name ?? s.source}`,
          }))}
          onRemove={(i) => onChange({ ...value, sources: value.sources.filter((_, n) => n !== i) })}
        />
        {picking?.what === "source" && (
          <SourcePicker
            choices={sourceChoices.filter(
              (c) => !value.sources.some((s) => s.kind === c.kind && s.source === c.source),
            )}
            isTaken={(label) => taken(value, label)}
            onAdd={addSource}
            onCancel={() => setPicking(null)}
          />
        )}
      </section>

      <p className="text-caption text-fg-muted">Model: Auto (workspace routing)</p>

      {error && (
        <p role="alert" className="text-dense text-destructive">
          {error}
        </p>
      )}
      {!readOnly && (
        <footer className="flex flex-wrap items-center gap-2">
          <Button onClick={() => onSave(true)} disabled={busy}>
            Save
          </Button>
          <Button variant="secondary" onClick={() => onSave(false)} disabled={busy}>
            Save as draft
          </Button>
          <span className="text-caption text-fg-muted">
            {busy
              ? "Saving…"
              : dirty
                ? "Unsaved changes"
                : hasLive
                  ? "Save makes this the live version; a draft leaves the live one as it is."
                  : "Nothing is live until you save."}
          </span>
        </footer>
      )}
    </div>
  );
}

function ItemList({
  items,
  empty,
  readOnly,
  onRemove,
}: {
  items: { key: string; label: string; detail: string }[];
  empty: string;
  readOnly: boolean;
  onRemove: (index: number) => void;
}) {
  if (items.length === 0) return <p className="text-dense text-fg-muted">{empty}</p>;
  return (
    <ul className="grid gap-1">
      {items.map((item, i) => (
        <li
          key={item.key}
          className="flex items-center gap-2 rounded-md border border-border px-2 py-1"
        >
          <span className="text-dense font-medium">@{item.label}</span>
          <span className="min-w-0 flex-1 truncate text-caption text-fg-muted">{item.detail}</span>
          {!readOnly && (
            <Button
              size="icon"
              variant="quiet"
              aria-label={`Remove @${item.label}`}
              onClick={() => onRemove(i)}
            >
              <X aria-hidden />
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}

function AttachmentPicker({
  choices,
  initialLabel,
  isTaken,
  onUpload,
  onAdd,
  onCancel,
}: {
  choices: readonly AttachChoice[];
  initialLabel: string;
  isTaken: (label: string) => boolean;
  onUpload?: (file: File) => Promise<AttachChoice>;
  onAdd: (item: AgentAttachmentItem) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const file = useRef<HTMLInputElement>(null);
  const [picked, setPicked] = useState<AttachChoice | null>(null);
  const [label, setLabel] = useState(initialLabel);
  const [problem, setProblem] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const kinds = [...new Set(choices.map((c) => c.kind))];

  const choose = (choice: AttachChoice | null) => {
    setPicked(choice);
    if (choice && !initialLabel) setLabel(toLabel(choice.name));
  };

  const upload = async (f: File) => {
    if (!onUpload) return;
    setUploading(true);
    setProblem(null);
    try {
      choose(await onUpload(f));
    } catch (err) {
      setProblem(err instanceof Error && err.message ? err.message : "That file didn't upload.");
    } finally {
      setUploading(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const name = label.trim();
    if (!picked) return setProblem("Pick something to attach.");
    if (!LABEL_PATTERN.test(name))
      return setProblem("A label starts with a letter: letters, digits, _ and spaces, up to 40.");
    if (isTaken(name)) return setProblem("Another attachment or source already uses that label.");
    onAdd({ label: name, kind: picked.kind, ref: picked.ref, name: picked.name });
  };

  return (
    <form
      onSubmit={submit}
      aria-label="Attach a file"
      className="grid gap-2 rounded-md border border-border bg-bg-raised p-3"
    >
      <div className="grid gap-1">
        <Label htmlFor={`${id}-what`}>What to attach</Label>
        <select
          id={`${id}-what`}
          className={selectStyles}
          value={picked ? `${picked.kind}:${picked.ref}` : ""}
          onChange={(e) =>
            choose(choices.find((c) => `${c.kind}:${c.ref}` === e.target.value) ?? null)
          }
        >
          <option value="">Choose…</option>
          {picked && !choices.some((c) => c.kind === picked.kind && c.ref === picked.ref) && (
            <option value={`${picked.kind}:${picked.ref}`}>{picked.name}</option>
          )}
          {kinds.map((kind) => (
            <optgroup key={kind} label={KIND_LABEL[kind]}>
              {choices
                .filter((c) => c.kind === kind)
                .map((c) => (
                  <option key={`${c.kind}:${c.ref}`} value={`${c.kind}:${c.ref}`}>
                    {c.name}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
      </div>
      {onUpload && (
        <div>
          <input
            ref={file}
            type="file"
            className="sr-only"
            tabIndex={-1}
            aria-hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void upload(f);
              e.target.value = "";
            }}
          />
          <Button
            size="sm"
            variant="secondary"
            disabled={uploading}
            onClick={() => file.current?.click()}
          >
            <Upload aria-hidden />
            {uploading ? "Uploading…" : "Upload a file"}
          </Button>
        </div>
      )}
      <div className="grid gap-1">
        <Label htmlFor={`${id}-label`}>Label</Label>
        <Input id={`${id}-label`} value={label} onChange={(e) => setLabel(e.target.value)} />
      </div>
      {problem && (
        <p role="alert" className="text-caption text-destructive">
          {problem}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" size="sm">
          Attach
        </Button>
        <Button size="sm" variant="quiet" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function SourcePicker({
  choices,
  isTaken,
  onAdd,
  onCancel,
}: {
  choices: readonly SourceChoice[];
  isTaken: (label: string) => boolean;
  onAdd: (item: AgentSourceItem) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const [picked, setPicked] = useState<SourceChoice | null>(null);
  const [label, setLabel] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const name = label.trim();
    if (!picked) return setProblem("Pick a source.");
    if (!LABEL_PATTERN.test(name))
      return setProblem("A label starts with a letter: letters, digits, _ and spaces, up to 40.");
    if (isTaken(name)) return setProblem("Another attachment or source already uses that label.");
    onAdd({ label: name, kind: picked.kind, source: picked.source, name: picked.name });
  };

  return (
    <form
      onSubmit={submit}
      aria-label="Add a source"
      className="grid gap-2 rounded-md border border-border bg-bg-raised p-3"
    >
      <div className="grid gap-1">
        <Label htmlFor={`${id}-what`}>Source</Label>
        <select
          id={`${id}-what`}
          className={selectStyles}
          value={picked ? `${picked.kind}:${picked.source}` : ""}
          onChange={(e) => {
            const next = choices.find((c) => `${c.kind}:${c.source}` === e.target.value) ?? null;
            setPicked(next);
            if (next) setLabel(toLabel(next.name));
          }}
        >
          <option value="">Choose…</option>
          {choices.map((c) => (
            <option key={`${c.kind}:${c.source}`} value={`${c.kind}:${c.source}`}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
      <div className="grid gap-1">
        <Label htmlFor={`${id}-label`}>Label</Label>
        <Input id={`${id}-label`} value={label} onChange={(e) => setLabel(e.target.value)} />
      </div>
      {problem && (
        <p role="alert" className="text-caption text-destructive">
          {problem}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" size="sm">
          Add
        </Button>
        <Button size="sm" variant="quiet" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export function AgentEditorSkeleton() {
  return (
    <div aria-busy="true" className="grid gap-4">
      <Skeleton className="h-4 w-24" />
      <Skeleton className="h-64 w-full" />
      <Skeleton className="h-5 w-40" />
      <Skeleton className="h-8 w-full" />
    </div>
  );
}
