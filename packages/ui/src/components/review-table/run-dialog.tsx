import { Dialog } from "radix-ui";
import { useEffect, useState } from "react";
import { cn } from "../../cn.js";
import { Button } from "../button.js";
import { Checkbox } from "../checkbox.js";
import { Skeleton } from "../status.js";
import { formatUsd } from "./types.js";

export const DRY_RUN_ROWS = 10;

export interface RunEstimate {
  cells: number;
  locked_skipped: number;
  verified_skipped: number;
  est_cost_usd: number;
  est_minutes: number;
}

export type RunChoice = {
  scope: "dry_run" | "all";
  include_verified: boolean;
  /** Re-run the columns that use this one after it, in order. */
  include_dependents?: boolean;
};

export function estimateLine(e: RunEstimate) {
  const minutes = e.est_minutes < 1 ? "under a minute" : `~${Math.ceil(e.est_minutes)} min`;
  const skipped = e.locked_skipped + e.verified_skipped;
  return [
    `${e.cells.toLocaleString()} cells`,
    minutes,
    `~${formatUsd(e.est_cost_usd)}`,
    skipped > 0 ? `${skipped.toLocaleString()} locked or verified kept` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Run a column. Over 10 rows it defaults to a dry run on the first 10, so a bad prompt
 * costs 10 cells, not thousands (RVT-010).
 */
export function RunDialog({
  open,
  onOpenChange,
  columnLabel,
  rowCount,
  rerun = false,
  dependents = [],
  estimate,
  onRun,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  columnLabel: string;
  rowCount: number;
  rerun?: boolean;
  /** Labels of the columns built on this one, directly or through others. */
  dependents?: readonly string[];
  estimate: (choice: RunChoice) => Promise<RunEstimate>;
  onRun: (choice: RunChoice) => void;
}) {
  const [scope, setScope] = useState<RunChoice["scope"]>(
    rowCount > DRY_RUN_ROWS ? "dry_run" : "all",
  );
  const [includeVerified, setIncludeVerified] = useState(false);
  const [includeDependents, setIncludeDependents] = useState(false);
  const [result, setResult] = useState<RunEstimate | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (open) setScope(rowCount > DRY_RUN_ROWS ? "dry_run" : "all");
  }, [open, rowCount]);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setResult(null);
    setFailed(false);
    estimate({ scope, include_verified: includeVerified }).then(
      (next) => live && setResult(next),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [open, scope, includeVerified, estimate]);

  const options = [
    ...(rowCount > DRY_RUN_ROWS
      ? [
          {
            id: "dry_run" as const,
            name: `Dry run on the first ${DRY_RUN_ROWS} rows`,
            hint: "Check the answers before running the rest.",
          },
        ]
      : []),
    {
      id: "all" as const,
      name: `Run all ${rowCount.toLocaleString()} rows`,
      hint: "Locked cells are never re-run.",
    },
  ];

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-fg/40 data-[state=open]:animate-fade-in" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 grid w-[min(28rem,calc(100vw-2rem))] -translate-1/2 gap-3 rounded-lg border border-border bg-bg-raised p-6 text-fg shadow-xl data-[state=open]:animate-fade-in">
          <Dialog.Title className="text-section font-semibold">
            {rerun ? "Re-run" : "Run"} {columnLabel}
          </Dialog.Title>
          <Dialog.Description className="text-ui text-fg-muted">
            Each document is read on its own; answers arrive as they finish.
          </Dialog.Description>
          <fieldset className="grid gap-2">
            <legend className="sr-only">How much to run</legend>
            {options.map((option) => (
              <label
                key={option.id}
                className={cn(
                  "flex cursor-pointer gap-2 rounded-md border border-border p-3 has-checked:border-accent has-checked:tint-selected",
                )}
              >
                <input
                  type="radio"
                  name="scope"
                  checked={scope === option.id}
                  onChange={() => setScope(option.id)}
                  className="mt-1"
                />
                <span className="grid">
                  <span className="font-medium">{option.name}</span>
                  <span className="text-caption text-fg-muted">{option.hint}</span>
                </span>
              </label>
            ))}
          </fieldset>
          {rerun && (
            <span className="flex items-center gap-1 text-ui">
              <Checkbox
                id="include-verified"
                checked={includeVerified}
                onCheckedChange={(value) => setIncludeVerified(value === true)}
              />
              <label htmlFor="include-verified">Also re-run verified cells</label>
            </span>
          )}
          {rerun && dependents.length > 0 && (
            <span className="flex items-center gap-1 text-ui">
              <Checkbox
                id="include-dependents"
                checked={includeDependents}
                onCheckedChange={(value) => setIncludeDependents(value === true)}
              />
              <label htmlFor="include-dependents">
                Also refresh columns that use it ({dependents.join(", ")})
              </label>
            </span>
          )}
          <p aria-live="polite" className="min-h-5 text-dense text-fg-muted">
            {failed ? (
              "Couldn't estimate the cost. You can still run it."
            ) : result ? (
              `Estimate: ${estimateLine(result)}`
            ) : (
              <span className="flex items-center gap-2">
                <span className="sr-only">Estimating…</span>
                <Skeleton className="h-3 w-56" />
              </span>
            )}
          </p>
          <div className="mt-2 flex justify-end gap-2">
            <Dialog.Close asChild>
              <Button variant="secondary">Cancel</Button>
            </Dialog.Close>
            <Button
              onClick={() => {
                onRun({
                  scope,
                  include_verified: includeVerified,
                  ...(includeDependents ? { include_dependents: true } : {}),
                });
                onOpenChange(false);
              }}
            >
              {scope === "dry_run" ? "Start dry run" : "Run"}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
