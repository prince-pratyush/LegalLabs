import { Download, History, RotateCcw } from "lucide-react";
import { useId } from "react";
import { cn } from "../../cn.js";
import { Button } from "../button.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../select.js";
import { Skeleton } from "../status.js";

export type DraftVersion = { no: number; createdAt: string; author: "assistant" | "user" };

export type DiffOp = { op: "equal" | "insert" | "delete"; text: string };

const when = new Intl.DateTimeFormat("en-AU", { dateStyle: "medium", timeStyle: "short" });

/** Tracked changes as a reader sees them in Word: inserted underlined, deleted struck. */
export function DiffView({ ops, className }: { ops: readonly DiffOp[]; className?: string }) {
  return (
    <div className={cn("text-prose whitespace-pre-wrap text-fg", className)}>
      {ops.map((op, i) =>
        op.op === "insert" ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: a diff run has no identity beyond position
          <ins key={i} className="text-verified underline decoration-2 underline-offset-2">
            <span className="sr-only">[inserted: </span>
            {op.text}
            <span className="sr-only">]</span>
          </ins>
        ) : op.op === "delete" ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: a diff run has no identity beyond position
          <del key={i} className="text-destructive line-through decoration-2">
            <span className="sr-only">[deleted: </span>
            {op.text}
            <span className="sr-only">]</span>
          </del>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: a diff run has no identity beyond position
          <span key={i}>{op.text}</span>
        ),
      )}
    </div>
  );
}

/** A draft with its versions: every edit is a new version, and any can come back. */
export function DraftPane({
  title,
  kind,
  versions,
  versionNo,
  onVersion,
  showEdits,
  onShowEdits,
  ops,
  body,
  onBody,
  onRestore,
  onExport,
  exporting = false,
  readOnly = false,
  className,
}: {
  title: string;
  kind: "notepad" | "editor";
  versions: readonly DraftVersion[];
  versionNo: number;
  onVersion: (no: number) => void;
  showEdits: boolean;
  onShowEdits: (on: boolean) => void;
  /** Changes from the version before this one. */
  ops: readonly DiffOp[];
  body: string;
  onBody: (text: string) => void;
  onRestore: () => void;
  onExport: () => void;
  exporting?: boolean;
  readOnly?: boolean;
  className?: string;
}) {
  const bodyId = useId();
  const latest = versions.reduce((max, v) => Math.max(max, v.no), 0);
  const old = versionNo !== latest;
  return (
    <section aria-label={title} className={cn("grid grid-rows-[auto_1fr] gap-3", className)}>
      <header className="flex flex-wrap items-center gap-2 border-b border-border pb-2">
        <h2 className="mr-auto truncate text-section font-semibold">
          {title}
          <span className="ml-2 text-caption font-normal text-fg-muted">
            {kind === "editor" ? "Editor" : "Notepad"}
          </span>
        </h2>
        <Select value={String(versionNo)} onValueChange={(v) => onVersion(Number(v))}>
          <SelectTrigger aria-label="Version" className="h-7 w-56 text-dense">
            <History aria-hidden className="size-4 text-fg-muted" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {[...versions]
              .sort((a, b) => b.no - a.no)
              .map((v) => (
                <SelectItem key={v.no} value={String(v.no)}>
                  v{v.no} · {v.author === "assistant" ? "Assistant" : "You"} ·{" "}
                  {when.format(new Date(v.createdAt))}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
        <Button
          variant={showEdits ? "secondary" : "quiet"}
          size="sm"
          aria-pressed={showEdits}
          onClick={() => onShowEdits(!showEdits)}
          disabled={versionNo <= 1}
        >
          Show edits
        </Button>
        {old && (
          <Button variant="secondary" size="sm" onClick={onRestore}>
            <RotateCcw aria-hidden />
            Restore this version
          </Button>
        )}
        <Button
          size="sm"
          onClick={onExport}
          disabled={exporting}
          aria-busy={exporting || undefined}
        >
          <Download aria-hidden />
          {exporting ? "Exporting…" : "Export to Word"}
        </Button>
      </header>
      {showEdits ? (
        <DiffView ops={ops} className="overflow-auto rounded-md border border-border p-4" />
      ) : (
        <>
          <label htmlFor={bodyId} className="sr-only">
            Draft text
          </label>
          <textarea
            id={bodyId}
            value={body}
            onChange={(e) => onBody(e.target.value)}
            // An older version is a record; edits only ever start from the latest.
            readOnly={readOnly || old}
            className="min-h-80 w-full resize-y rounded-md border border-control bg-bg-raised p-4 font-mono text-body text-fg read-only:bg-bg-subtle"
          />
        </>
      )}
    </section>
  );
}

export function DraftPaneSkeleton() {
  return (
    <div className="grid gap-3" aria-hidden>
      <div className="flex gap-2">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="ml-auto h-7 w-56" />
        <Skeleton className="h-7 w-32" />
      </div>
      <Skeleton className="h-80 w-full" />
    </div>
  );
}
