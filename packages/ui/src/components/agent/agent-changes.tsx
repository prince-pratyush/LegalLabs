import { Minus, Plus } from "lucide-react";
import { useId, useState } from "react";
import { cn } from "../../cn.js";
import { Button } from "../button.js";
import { Skeleton } from "../status.js";
import { type DiffOp, DiffView } from "../thread/draft-pane.js";
import { formatWhen, KIND_LABEL } from "./types.js";

export type ChangedItem = { kind: keyof typeof KIND_LABEL; label: string; name: string };
export type ItemChanges = { added: ChangedItem[]; removed: ChangedItem[] };

/** One side of a redline: what the reader sees before or after the change. */
function Side({ ops, side }: { ops: readonly DiffOp[]; side: "before" | "after" }) {
  const drop = side === "before" ? "insert" : "delete";
  return (
    <div className="text-prose whitespace-pre-wrap text-fg">
      {ops
        .filter((op) => op.op !== drop)
        .map((op, i) =>
          op.op === "equal" ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: a diff run has no identity beyond position
            <span key={i}>{op.text}</span>
          ) : op.op === "insert" ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: a diff run has no identity beyond position
            <ins key={i} className="text-verified underline decoration-2 underline-offset-2">
              {op.text}
            </ins>
          ) : (
            // biome-ignore lint/suspicious/noArrayIndexKey: a diff run has no identity beyond position
            <del key={i} className="text-destructive line-through decoration-2">
              {op.text}
            </del>
          ),
        )}
    </div>
  );
}

function ItemDiff({ title, changes }: { title: string; changes: ItemChanges }) {
  if (changes.added.length === 0 && changes.removed.length === 0) return null;
  return (
    <section className="grid gap-1">
      <h4 className="text-dense font-semibold">{title}</h4>
      <ul className="grid gap-0.5">
        {changes.added.map((x) => (
          <li key={`+${x.kind}:${x.label}`} className="flex items-center gap-1.5 text-dense">
            <Plus aria-hidden className="size-3.5 text-verified" />
            <span className="sr-only">Added: </span>@{x.label}
            <span className="text-fg-muted">
              · {KIND_LABEL[x.kind]} · {x.name}
            </span>
          </li>
        ))}
        {changes.removed.map((x) => (
          <li key={`-${x.kind}:${x.label}`} className="flex items-center gap-1.5 text-dense">
            <Minus aria-hidden className="size-3.5 text-destructive" />
            <span className="sr-only">Removed: </span>
            <span className="line-through">@{x.label}</span>
            <span className="text-fg-muted">
              · {KIND_LABEL[x.kind]} · {x.name}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * What a draft changes against the live version. The redline is computed, never written by
 * a model, so the same two versions always show the same changes.
 */
export function AgentChanges({
  ops,
  attachments,
  sources,
  fromLabel,
  toLabel,
  onAccept,
  onDiscard,
  busy = false,
}: {
  ops: readonly DiffOp[];
  attachments: ItemChanges;
  sources: ItemChanges;
  fromLabel: string;
  toLabel: string;
  /** Accept keeps the draft; left out, the view is read only. */
  onAccept?: () => void;
  onDiscard?: () => void;
  busy?: boolean;
}) {
  const [mode, setMode] = useState<"redline" | "side">("redline");
  const id = useId();
  const unchanged =
    ops.every((op) => op.op === "equal") &&
    attachments.added.length + attachments.removed.length === 0 &&
    sources.added.length + sources.removed.length === 0;
  return (
    <section aria-labelledby={id} className="grid gap-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={id} className="text-section font-semibold">
          Changes <span className="font-normal text-fg-muted">from {fromLabel}</span> to {toLabel}
        </h3>
        <fieldset className="flex gap-1">
          <legend className="sr-only">Show changes as</legend>
          <Button
            size="sm"
            variant={mode === "redline" ? "secondary" : "quiet"}
            aria-pressed={mode === "redline"}
            onClick={() => setMode("redline")}
          >
            Redline
          </Button>
          <Button
            size="sm"
            variant={mode === "side" ? "secondary" : "quiet"}
            aria-pressed={mode === "side"}
            onClick={() => setMode("side")}
          >
            Side by side
          </Button>
        </fieldset>
      </header>
      {unchanged ? (
        <p className="text-dense text-fg-muted">No changes.</p>
      ) : mode === "redline" ? (
        <DiffView ops={ops} className="rounded-md border border-border p-3" />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          <div className="grid content-start gap-1">
            <p className="text-caption font-semibold text-fg-muted uppercase">{fromLabel}</p>
            <div className="rounded-md border border-border p-3">
              <Side ops={ops} side="before" />
            </div>
          </div>
          <div className="grid content-start gap-1">
            <p className="text-caption font-semibold text-fg-muted uppercase">{toLabel}</p>
            <div className="rounded-md border border-border p-3">
              <Side ops={ops} side="after" />
            </div>
          </div>
        </div>
      )}
      <ItemDiff title="Attachments" changes={attachments} />
      <ItemDiff title="Sources" changes={sources} />
      {(onAccept || onDiscard) && (
        <footer className="flex gap-2">
          {onAccept && (
            <Button onClick={onAccept} disabled={busy}>
              Accept
            </Button>
          )}
          {onDiscard && (
            <Button variant="secondary" onClick={onDiscard} disabled={busy}>
              Discard draft
            </Button>
          )}
        </footer>
      )}
    </section>
  );
}

export type VersionRow = {
  id: string;
  no: number;
  createdAt: string;
  live: boolean;
  draft: boolean;
};

/** Every saved version, newest first; any two can be compared. */
export function AgentVersionList({
  versions,
  onCompare,
}: {
  versions: readonly VersionRow[];
  /** Compares a version with the one before it. */
  onCompare?: (version: VersionRow) => void;
}) {
  if (versions.length === 0) return <p className="text-dense text-fg-muted">No versions yet.</p>;
  return (
    <ol aria-label="Versions" className="grid gap-1">
      {versions.map((v, i) => (
        <li
          key={v.id}
          className={cn(
            "flex flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2",
            v.live && "tint-selected",
          )}
        >
          <span className="text-dense font-medium">Version {v.no}</span>
          {v.live && <span className="text-caption text-verified">Live</span>}
          {v.draft && <span className="text-caption text-warning">Draft</span>}
          <span className="text-caption text-fg-muted">{formatWhen(v.createdAt)}</span>
          {onCompare && i < versions.length - 1 && (
            <Button
              size="sm"
              variant="quiet"
              className="ml-auto"
              aria-label={`Compare version ${v.no} with the one before`}
              onClick={() => onCompare(v)}
            >
              Compare
            </Button>
          )}
        </li>
      ))}
    </ol>
  );
}

export function AgentChangesSkeleton() {
  return (
    <div aria-busy="true" className="grid gap-3">
      <Skeleton className="h-5 w-48" />
      <Skeleton className="h-32 w-full" />
    </div>
  );
}
