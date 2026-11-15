import { Circle, LoaderCircle } from "lucide-react";
import { Button } from "../button.js";
import { Skeleton, StatusText } from "../status.js";
import { elapsed, type ProgressState, rulesFinished } from "./order.js";
import { FindingStatusText } from "./status.js";

/** The run while it works: "Rule 4 of 12 · 1 m 40 s", then each rule as it finishes. */
export function ReviewProgress({
  rules,
  state,
  elapsedMs,
  cancelling = false,
  onCancel,
}: {
  /** In-scope rules, in playbook order. */
  rules: readonly { id: string; title: string }[];
  state: ProgressState;
  elapsedMs?: number;
  cancelling?: boolean;
  onCancel?: () => void;
}) {
  const total = rules.length;
  const finished = rulesFinished(state);
  const percent = total === 0 ? 0 : Math.round((finished / total) * 100);
  const running = state.finished === null;
  return (
    <section aria-label="Review progress" className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p aria-live="polite" className="text-dense font-medium tabular-nums">
          {running
            ? `Rule ${Math.min(finished + 1, total)} of ${total}`
            : state.finished === "done"
              ? `Reviewed ${total} rules`
              : state.finished === "cancelled"
                ? `Cancelled after ${finished} of ${total} rules`
                : "The review stopped"}
          {elapsedMs !== undefined && ` · ${elapsed(elapsedMs)}`}
        </p>
        {running && onCancel && (
          <Button variant="secondary" size="sm" onClick={onCancel} disabled={cancelling}>
            {cancelling ? "Cancelling…" : "Cancel review"}
          </Button>
        )}
      </div>
      <div
        role="progressbar"
        aria-label="Rules reviewed"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="h-1.5 overflow-hidden rounded-full bg-border"
      >
        <div
          className="h-full bg-accent transition-[width] duration-(--motion-fast)"
          style={{ width: `${percent}%` }}
        />
      </div>
      {state.error && (
        <p role="alert" className="text-destructive">
          {state.error}
        </p>
      )}
      <ol className="grid gap-1">
        {rules.map((rule) => {
          const s = state.rules[rule.id] ?? "queued";
          return (
            <li key={rule.id} className="flex items-center justify-between gap-3 text-ui">
              <span className="truncate">{rule.title}</span>
              {s === "queued" ? (
                <span className="inline-flex items-center gap-1 text-fg-muted">
                  <Circle aria-hidden className="size-4" strokeWidth={1.5} />
                  Waiting
                </span>
              ) : s === "running" ? (
                <StatusText tone="running">Reviewing</StatusText>
              ) : (
                <FindingStatusText status={s} />
              )}
            </li>
          );
        })}
        <li className="flex items-center justify-between gap-3 text-ui">
          <span>Clauses outside the playbook</span>
          {state.gapPass === "done" ? (
            <span className="text-fg-muted tabular-nums">
              {state.gapCount === 1 ? "1 found" : `${state.gapCount ?? 0} found`}
            </span>
          ) : state.gapPass === "running" ? (
            <span className="inline-flex items-center gap-1 text-accent">
              <LoaderCircle aria-hidden className="size-4 animate-spin" strokeWidth={1.5} />
              Checking
            </span>
          ) : (
            <span className="text-fg-muted">Waiting</span>
          )}
        </li>
      </ol>
    </section>
  );
}

export function ReviewProgressSkeleton() {
  return (
    <div aria-busy="true" className="grid gap-3">
      <span className="sr-only">Loading…</span>
      <Skeleton className="h-5 w-40" />
      <Skeleton className="h-1.5" />
      {[0, 1, 2, 3].map((i) => (
        <Skeleton key={i} className="h-5" />
      ))}
    </div>
  );
}
