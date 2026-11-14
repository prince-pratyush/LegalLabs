import { Cpu } from "lucide-react";
import { cn } from "../../cn.js";
import { Popover, PopoverContent, PopoverTrigger } from "../popover.js";
import { Skeleton } from "../status.js";
import { formatCost, formatCount, isLocalModel } from "./format.js";

export type ModelBadgeProps = {
  /** Null when no model ran, e.g. nothing in scope matched. */
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  /** The model asked for, when a fallback answered instead. */
  fallbackFrom?: string;
  scope?: string;
  className?: string;
};

/** Says which model answered, what it read and what it cost, so nothing is hidden. */
export function ModelBadge({
  model,
  inputTokens,
  outputTokens,
  costUsd,
  fallbackFrom,
  scope,
  className,
}: ModelBadgeProps) {
  const local = isLocalModel(model);
  const total = inputTokens + outputTokens;
  const cost = formatCost(costUsd, local);
  const name = model ?? "No model used";
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex h-6 items-center gap-1.5 rounded-md px-1.5 text-caption text-fg-muted tabular-nums hover:tint-hover",
            className,
          )}
        >
          <Cpu aria-hidden className="size-3.5" strokeWidth={1.5} />
          <span>{name}</span>
          {model && (
            <>
              <span aria-hidden>·</span>
              <span>{formatCount(total)} tok</span>
              <span aria-hidden>·</span>
              <span>{cost}</span>
            </>
          )}
          {fallbackFrom && <span className="text-warning">(fallback)</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent className="grid gap-1 text-dense">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          <dt className="text-fg-muted">Model</dt>
          <dd>{name}</dd>
          {fallbackFrom && (
            <>
              <dt className="text-fg-muted">Asked for</dt>
              <dd>{fallbackFrom}, unavailable</dd>
            </>
          )}
          {scope && (
            <>
              <dt className="text-fg-muted">Scope</dt>
              <dd>{scope}</dd>
            </>
          )}
          <dt className="text-fg-muted">Tokens in</dt>
          <dd className="tabular-nums">{formatCount(inputTokens)}</dd>
          <dt className="text-fg-muted">Tokens out</dt>
          <dd className="tabular-nums">{formatCount(outputTokens)}</dd>
          <dt className="text-fg-muted">Cost</dt>
          <dd className="tabular-nums">{local && costUsd === 0 ? "Free (runs locally)" : cost}</dd>
        </dl>
      </PopoverContent>
    </Popover>
  );
}

export function ModelBadgeSkeleton() {
  return <Skeleton className="h-6 w-56" />;
}
