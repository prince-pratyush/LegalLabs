import { CircleCheck, Flag, Lock, RotateCcw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "../../cn.js";
import { Button } from "../button.js";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "../menu.js";
import { FLAG_CLASS, FLAG_COLORS, type FlagColor, flagName, formatUsd } from "./types.js";

export type BulkOp = "verify" | "unverify" | "lock" | "unlock" | "flag" | "unflag" | "rerun";
export type BulkRequest = { op: BulkOp; flag_color?: FlagColor };

const VERBS: Record<BulkOp, string> = {
  verify: "Verify",
  unverify: "Unverify",
  lock: "Lock",
  unlock: "Unlock",
  flag: "Flag",
  unflag: "Unflag",
  rerun: "Re-run",
};

const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;

/** "Re-run 312 cells in 2 columns · ~6 min · ~$1.80 · verified cells preserved". */
export function sheetText(
  request: BulkRequest,
  cells: number,
  columns: number,
  estimate?: { est_cost_usd: number; est_minutes: number } | null,
) {
  const verb =
    request.op === "flag" && request.flag_color
      ? `Flag ${flagName(request.flag_color).toLowerCase()}`
      : VERBS[request.op];
  const parts = [`${verb} ${plural(cells, "cell")} in ${plural(columns, "column")}`];
  if (request.op === "rerun") {
    if (estimate) {
      parts.push(`~${Math.max(1, Math.ceil(estimate.est_minutes))} min`);
      parts.push(`~${formatUsd(estimate.est_cost_usd)}`);
    }
    parts.push("verified and locked cells preserved");
  }
  return parts.join(" · ");
}

/**
 * Floating actions for a multi-cell selection. Bulk changes can't be undone, so each one
 * is confirmed in an inline sheet that names the count and cost (UX §5.7).
 */
export function BulkBar({
  cellCount,
  columnCount,
  estimate,
  onConfirm,
  onClear,
}: {
  cellCount: number;
  columnCount: number;
  estimate?: () => Promise<{ est_cost_usd: number; est_minutes: number }>;
  onConfirm: (request: BulkRequest) => Promise<void> | void;
  onClear: () => void;
}) {
  const [pending, setPending] = useState<BulkRequest | null>(null);
  const [cost, setCost] = useState<{ est_cost_usd: number; est_minutes: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (pending) confirmRef.current?.focus();
  }, [pending]);

  const ask = (request: BulkRequest) => {
    setPending(request);
    setError(null);
    setCost(null);
    if (request.op === "rerun" && estimate) estimate().then(setCost, () => setCost(null));
  };

  const confirm = async () => {
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(pending);
      setPending(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      aria-label="Selected cells"
      className="fixed bottom-6 left-1/2 z-40 grid w-[min(44rem,calc(100vw-2rem))] -translate-x-1/2 gap-2 rounded-lg border border-border bg-bg-raised p-2 text-ui shadow-xl animate-pop-in"
    >
      {pending ? (
        <fieldset
          aria-label="Confirm bulk change"
          className="m-0 flex min-w-0 flex-wrap items-center gap-2 border-0 p-0 px-2"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              setPending(null);
            }
          }}
        >
          <p className="min-w-0 flex-1" aria-live="polite">
            {sheetText(pending, cellCount, columnCount, cost)}
            <span className="text-fg-muted"> · can't be undone</span>
          </p>
          {error && (
            <p role="alert" className="w-full text-caption text-destructive">
              {error}
            </p>
          )}
          <Button variant="secondary" size="sm" onClick={() => setPending(null)}>
            Cancel
          </Button>
          <Button ref={confirmRef} size="sm" onClick={confirm} disabled={busy}>
            {busy ? "Working…" : "Confirm"}
          </Button>
        </fieldset>
      ) : (
        <div className="flex flex-wrap items-center gap-1">
          <span className="px-2 font-medium">{plural(cellCount, "cell")} selected</span>
          <Button variant="quiet" size="sm" onClick={() => ask({ op: "verify" })}>
            <CircleCheck aria-hidden />
            Verify
          </Button>
          <Menu>
            <MenuTrigger asChild>
              <Button variant="quiet" size="sm">
                <Flag aria-hidden />
                Flag
              </Button>
            </MenuTrigger>
            <MenuContent>
              {FLAG_COLORS.map((color) => (
                <MenuItem key={color} onSelect={() => ask({ op: "flag", flag_color: color })}>
                  <Flag aria-hidden className={cn(FLAG_CLASS[color].text)} fill="currentColor" />
                  {flagName(color)}
                </MenuItem>
              ))}
              <MenuSeparator />
              <MenuItem onSelect={() => ask({ op: "unflag" })}>Remove flag</MenuItem>
            </MenuContent>
          </Menu>
          <Button variant="quiet" size="sm" onClick={() => ask({ op: "lock" })}>
            <Lock aria-hidden />
            Lock
          </Button>
          <Button variant="quiet" size="sm" onClick={() => ask({ op: "rerun" })}>
            <RotateCcw aria-hidden />
            Re-run
          </Button>
          <Menu>
            <MenuTrigger asChild>
              <Button variant="quiet" size="sm">
                More
              </Button>
            </MenuTrigger>
            <MenuContent>
              <MenuItem onSelect={() => ask({ op: "unverify" })}>Unverify</MenuItem>
              <MenuItem onSelect={() => ask({ op: "unlock" })}>Unlock</MenuItem>
            </MenuContent>
          </Menu>
          <Button
            variant="quiet"
            size="icon"
            aria-label="Clear selection"
            onClick={onClear}
            className="ml-auto"
          >
            <X aria-hidden />
          </Button>
        </div>
      )}
    </section>
  );
}
