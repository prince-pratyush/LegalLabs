import { type FormEvent, useId, useState } from "react";
import { Button } from "../button.js";
import { Checkbox } from "../checkbox.js";
import { Input, Label } from "../field.js";
import { StatusText } from "../status.js";
import { KIND_LABEL } from "./types.js";

export type ImportStatus = "ok" | "unknown_source" | "not_enabled" | "too_large" | "unsupported";

export type ImportPreviewData = {
  title: string;
  description: string;
  instructions: string;
  files: { label: string; name: string; size: number; status: ImportStatus }[];
  refs: { label: string; kind: string; name: string; resolved: boolean }[];
  sources: { label: string; source: string; status: ImportStatus }[];
  issues: { kind: string; label: string; status: ImportStatus; detail?: string | undefined }[];
};

const STATUS_TEXT: Record<Exclude<ImportStatus, "ok">, string> = {
  unknown_source: "Unknown source, dropped on import",
  not_enabled: "Not enabled in this workspace, dropped on import",
  too_large: "Too large, dropped on import",
  unsupported: "File type not supported, dropped on import",
};

const size = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${Math.round(bytes / 1024)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

function Status({ status }: { status: ImportStatus }) {
  return status === "ok" ? (
    <StatusText tone="verified" className="text-caption">
      Ready
    </StatusText>
  ) : (
    <StatusText tone="warning" className="text-caption">
      {STATUS_TEXT[status]}
    </StatusText>
  );
}

/** What an import will create, before anything is stored; nothing goes live until saved. */
export function ImportPreview({
  preview,
  busy = false,
  error,
  onConfirm,
  onCancel,
}: {
  preview: ImportPreviewData;
  busy?: boolean;
  error?: string | null;
  onConfirm: (choice: { title: string; dropLabels: string[] }) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const [title, setTitle] = useState(preview.title);
  const [dropped, setDropped] = useState<Set<string>>(new Set());
  const toggle = (label: string, keep: boolean) =>
    setDropped((d) => {
      const next = new Set(d);
      if (keep) next.delete(label);
      else next.add(label);
      return next;
    });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onConfirm({ title: title.trim() || preview.title, dropLabels: [...dropped] });
  };
  const keepable = [
    ...preview.files.filter((f) => f.status === "ok").map((f) => ({ ...f, detail: size(f.size) })),
    ...preview.refs
      .filter((r) => r.resolved)
      .map((r) => ({
        label: r.label,
        name: r.name,
        detail: KIND_LABEL[r.kind as keyof typeof KIND_LABEL] ?? r.kind,
      })),
  ];
  const lost = [
    ...preview.files.filter((f) => f.status !== "ok"),
    ...preview.refs
      .filter((r) => !r.resolved)
      .map((r) => ({ label: r.label, name: r.name, status: "unknown_source" as const })),
  ];

  return (
    <form onSubmit={submit} aria-label="Import preview" className="grid gap-4">
      <div className="grid gap-1">
        <Label htmlFor={`${id}-title`}>Title</Label>
        <Input
          id={`${id}-title`}
          value={title}
          maxLength={120}
          onChange={(e) => setTitle(e.target.value)}
        />
      </div>
      {preview.description && <p className="text-dense text-fg-muted">{preview.description}</p>}
      <section className="grid gap-1">
        <h3 className="text-ui font-semibold">Instructions</h3>
        <pre className="max-h-48 overflow-auto rounded-md border border-border p-2 font-mono text-caption whitespace-pre-wrap">
          {preview.instructions}
        </pre>
      </section>
      <section className="grid gap-1">
        <h3 className="text-ui font-semibold">Files</h3>
        {keepable.length === 0 && lost.length === 0 ? (
          <p className="text-dense text-fg-muted">No files.</p>
        ) : (
          <ul className="grid gap-1">
            {keepable.map((f) => (
              <li key={f.label} className="flex items-center gap-2">
                <Checkbox
                  id={`${id}-keep-${f.label}`}
                  checked={!dropped.has(f.label)}
                  onCheckedChange={(on) => toggle(f.label, on === true)}
                />
                <Label htmlFor={`${id}-keep-${f.label}`} className="min-w-0 flex-1 truncate">
                  {f.name} <span className="font-normal text-fg-muted">· {f.detail}</span>
                </Label>
              </li>
            ))}
            {lost.map((f) => (
              <li key={f.label} className="flex flex-wrap items-center gap-2 pl-8">
                <span className="text-dense">{f.name}</span>
                <Status status={f.status} />
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="grid gap-1">
        <h3 className="text-ui font-semibold">Sources</h3>
        {preview.sources.length === 0 ? (
          <p className="text-dense text-fg-muted">No sources.</p>
        ) : (
          <ul className="grid gap-1">
            {preview.sources.map((s) => (
              <li key={s.label} className="flex flex-wrap items-center gap-2">
                <span className="text-dense font-medium">@{s.label}</span>
                <span className="text-caption text-fg-muted">{s.source}</span>
                <Status status={s.status} />
              </li>
            ))}
          </ul>
        )}
      </section>
      {preview.issues.some((i) => i.detail) && (
        <section className="grid gap-1">
          <h3 className="text-ui font-semibold">Notes</h3>
          <ul className="grid list-disc gap-0.5 pl-5 text-dense text-fg-muted">
            {preview.issues
              .filter((i) => i.detail)
              .map((i) => (
                <li key={`${i.kind}:${i.label}`}>
                  {i.label}: {i.detail}
                </li>
              ))}
          </ul>
        </section>
      )}
      <p className="text-caption text-fg-muted">
        The agent is created as a draft. Nothing runs until you save it.
      </p>
      {error && (
        <p role="alert" className="text-dense text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" disabled={busy}>
          Confirm import
        </Button>
        <Button variant="quiet" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
