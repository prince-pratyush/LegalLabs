import { Circle, CircleCheck, CircleX, LoaderCircle, Minus } from "lucide-react";
import { cn } from "../../cn.js";
import { Skeleton } from "../status.js";
import { formatCost, formatCount } from "./format.js";

export type StepStatus = "queued" | "running" | "done" | "failed" | "skipped";

export type RunStep = {
  id: string;
  title: string;
  status: StepStatus;
  detail?: string;
  costUsd?: number;
};

export type RunCoverage = {
  docsRead: number;
  docsInScope: number;
  pagesRead: number;
  pagesInScope: number;
};

const ICONS = {
  queued: { icon: Circle, label: "Queued", tone: "text-fg-muted" },
  running: { icon: LoaderCircle, label: "Running", tone: "text-accent animate-spin" },
  done: { icon: CircleCheck, label: "Done", tone: "text-verified" },
  failed: { icon: CircleX, label: "Failed", tone: "text-destructive" },
  skipped: { icon: Minus, label: "Skipped", tone: "text-fg-muted" },
} as const;

const percent = (part: number, whole: number) =>
  whole === 0 ? 0 : Math.round((Math.min(part, whole) / whole) * 100);

/** "Read 312 of 1,204 files (26%) · 4,120 of 18,900 pages" */
export function coverageLine(coverage: RunCoverage): string {
  const { docsRead, docsInScope, pagesRead, pagesInScope } = coverage;
  return `Read ${formatCount(docsRead)} of ${formatCount(docsInScope)} files (${percent(docsRead, docsInScope)}%) · ${formatCount(pagesRead)} of ${formatCount(pagesInScope)} pages`;
}

/** The current step is always named, so a long run never looks frozen. */
export function RunProgress({
  steps,
  coverage,
  className,
}: {
  steps: readonly RunStep[];
  coverage?: RunCoverage;
  className?: string;
}) {
  const current = steps.findIndex((step) => step.status === "running");
  const finished = steps.filter((step) => step.status === "done" || step.status === "skipped");
  const position = current === -1 ? finished.length : current + 1;
  const spent = steps.reduce((sum, step) => sum + (step.costUsd ?? 0), 0);
  return (
    <section aria-label="Progress" className={cn("grid gap-3", className)}>
      <p aria-live="polite" className="text-dense font-medium text-fg tabular-nums">
        Step {Math.min(position, steps.length)} of {steps.length} · {formatCost(spent)}
      </p>
      {coverage && (
        <div className="grid gap-1">
          <div
            role="progressbar"
            aria-label="Files read"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent(coverage.docsRead, coverage.docsInScope)}
            className="h-1.5 overflow-hidden rounded-full bg-border"
          >
            <div
              className="h-full bg-accent transition-[width] duration-(--motion-fast)"
              style={{ width: `${percent(coverage.docsRead, coverage.docsInScope)}%` }}
            />
          </div>
          <p className="text-caption text-fg-muted tabular-nums">{coverageLine(coverage)}</p>
        </div>
      )}
      <ol className="grid gap-1">
        {steps.map((step) => {
          const { icon: Icon, label, tone } = ICONS[step.status];
          return (
            <li
              key={step.id}
              aria-current={step.status === "running" ? "step" : undefined}
              className="grid grid-cols-[auto_1fr_auto] items-start gap-2 rounded-md px-2 py-1 aria-[current=step]:tint-selected"
            >
              <Icon aria-hidden className={cn("mt-0.5 size-4", tone)} strokeWidth={1.5} />
              <span className="grid">
                <span className="text-dense text-fg">
                  {step.title}
                  <span className="sr-only"> ({label})</span>
                </span>
                {step.detail && <span className="text-caption text-fg-muted">{step.detail}</span>}
              </span>
              {step.costUsd !== undefined && (
                <span className="text-caption text-fg-muted tabular-nums">
                  {formatCost(step.costUsd)}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

export function RunProgressSkeleton() {
  return (
    <div className="grid gap-2" aria-hidden>
      <Skeleton className="h-4 w-40" />
      <Skeleton className="h-1.5 w-full" />
      <Skeleton className="h-6 w-full" />
      <Skeleton className="h-6 w-full" />
    </div>
  );
}
