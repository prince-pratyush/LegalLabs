import {
  CircleCheck,
  CircleDashed,
  Clock,
  Flag,
  History,
  LoaderCircle,
  Lock,
  Pencil,
  Quote,
  TriangleAlert,
} from "lucide-react";
import { cn } from "../../cn.js";
import { Skeleton } from "../status.js";
import { errorText, FLAG_CLASS, flagName, type GridCell } from "./types.js";

/** Seconds since the cell started running; updated_at marks the start. */
export const elapsedSeconds = (cell: Pick<GridCell, "updated_at">, now: number) =>
  Math.max(0, Math.round((now - Date.parse(cell.updated_at)) / 1000));

/**
 * One cell's state as icon plus words, so no state depends on colour (UX §5.3).
 * States combine: a verified value can also be flagged and locked.
 */
export function ReviewCell({
  cell,
  now = Date.now(),
  onRetry,
  onLooked,
}: {
  cell: GridCell | undefined;
  now?: number;
  onRetry?: () => void;
  onLooked?: () => void;
}) {
  if (!cell || cell.status === "pending") {
    return (
      <span className="inline-flex items-center gap-1 text-caption text-fg-muted">
        <CircleDashed aria-hidden className="size-3.5" />
        Not run
      </span>
    );
  }
  return (
    <span
      data-status={cell.status}
      className={cn(
        "flex min-w-0 items-center gap-1",
        cell.locked && "opacity-60",
        cell.status === "running" && "animate-shimmer",
      )}
    >
      {cell.flag_color && (
        <Flag
          aria-label={`Flagged ${flagName(cell.flag_color)}`}
          role="img"
          className={cn("size-3.5 shrink-0", FLAG_CLASS[cell.flag_color].text)}
          fill="currentColor"
        />
      )}
      {cell.locked && <Lock aria-label="Locked" role="img" className="size-3.5 shrink-0" />}
      {cell.verified_at && (
        <CircleCheck aria-label="Verified" role="img" className="size-3.5 shrink-0 text-verified" />
      )}
      {cell.edited_by && (
        <Pencil aria-label="Edited" role="img" className="size-3.5 shrink-0 text-fg-muted" />
      )}
      <Body cell={cell} now={now} onRetry={onRetry} onLooked={onLooked} />
    </span>
  );
}

function Body({
  cell,
  now,
  onRetry,
  onLooked,
}: {
  cell: GridCell;
  now: number;
  onRetry?: (() => void) | undefined;
  onLooked?: (() => void) | undefined;
}) {
  switch (cell.status) {
    case "queued":
      return (
        <span className="inline-flex items-center gap-1 text-fg-muted">
          <Clock aria-hidden className="size-3.5" />
          Queued
        </span>
      );
    case "running":
      return (
        <span className="inline-flex items-center gap-1 text-accent">
          <LoaderCircle aria-hidden className="size-3.5" />
          Running {elapsedSeconds(cell, now)} s
        </span>
      );
    case "blocked":
      return (
        <span className="inline-flex items-center gap-1 text-fg-muted">
          <Clock aria-hidden className="size-3.5" />
          Waiting
        </span>
      );
    case "error":
      return (
        <span className="inline-flex min-w-0 items-center gap-1 text-destructive">
          <TriangleAlert aria-hidden className="size-3.5 shrink-0" />
          <span title={errorText(cell.error_code)}>Error</span>
          {onRetry && (
            <button
              type="button"
              tabIndex={-1}
              onClick={(event) => {
                event.stopPropagation();
                onRetry();
              }}
              className="rounded-sm px-1 underline underline-offset-2 hover:text-fg"
            >
              Retry
            </button>
          )}
        </span>
      );
    case "null":
      return (
        <span className="inline-flex items-center gap-1 text-fg-muted">
          <span aria-hidden>—</span>
          <span className="sr-only">No answer.</span>
          <button
            type="button"
            tabIndex={-1}
            onClick={(event) => {
              event.stopPropagation();
              onLooked?.();
            }}
            className="rounded-sm px-1 text-caption underline underline-offset-2 hover:text-fg"
          >
            Where I looked ▸
          </button>
        </span>
      );
    default:
      return (
        <>
          <span className="min-w-0 truncate">{cell.value_text}</span>
          {cell.status === "stale" && (
            <span className="inline-flex shrink-0 items-center gap-0.5 text-caption text-warning">
              <History aria-hidden className="size-3" />
              Stale
            </span>
          )}
          {cell.citation_count > 0 && (
            <span className="ml-auto inline-flex shrink-0 items-center gap-0.5 rounded-sm border border-border px-1 text-caption text-citation">
              <Quote aria-hidden className="size-3" />
              {cell.citation_count}
              <span className="sr-only"> citations</span>
            </span>
          )}
        </>
      );
  }
}

export function ReviewCellSkeleton() {
  return <Skeleton className="h-3 w-3/4" />;
}
