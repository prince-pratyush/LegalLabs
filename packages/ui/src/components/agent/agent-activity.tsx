import { CalendarClock } from "lucide-react";
import { Skeleton, StatusText, type Tone } from "../status.js";
import { formatCost } from "../thread/format.js";
import { formatDuration, formatWhen } from "./types.js";

export type ActivityRun = {
  id: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  costUsd: number;
  testMode: boolean;
  errorCode: string | null;
};

const STATUS: Record<string, { tone: Tone; label: string }> = {
  done: { tone: "verified", label: "Done" },
  failed: { tone: "failed", label: "Failed" },
  cancelled: { tone: "locked", label: "Cancelled" },
  running: { tone: "running", label: "Running" },
  verifying: { tone: "running", label: "Checking sources" },
  planned: { tone: "running", label: "Planning" },
  awaiting_approval: { tone: "warning", label: "Waiting for approval" },
  awaiting_input: { tone: "warning", label: "Waiting for an answer" },
};

export function RunStatusText({ status }: { status: string }) {
  const s = STATUS[status] ?? { tone: "running" as const, label: status };
  return (
    <StatusText tone={s.tone} className="text-dense">
      {s.label}
    </StatusText>
  );
}

/** Your runs of one agent: what happened, how long it took and what it cost. */
export function AgentActivity({
  runs,
  nextRunAt,
  onOpen,
}: {
  runs: readonly ActivityRun[];
  nextRunAt: string | null;
  onOpen: (run: ActivityRun) => void;
}) {
  return (
    <div className="grid gap-3">
      {nextRunAt && (
        <p className="flex items-center gap-1.5 text-dense text-fg-muted">
          <CalendarClock aria-hidden className="size-4" strokeWidth={1.5} />
          Next scheduled run {formatWhen(nextRunAt)}
        </p>
      )}
      {runs.length === 0 ? (
        <p className="text-dense text-fg-muted">You haven't run this agent yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-dense">
            <caption className="sr-only">Runs</caption>
            <thead className="text-caption text-fg-muted">
              <tr>
                <th scope="col" className="py-1 pr-3 font-medium">
                  Started
                </th>
                <th scope="col" className="py-1 pr-3 font-medium">
                  Status
                </th>
                <th scope="col" className="py-1 pr-3 font-medium">
                  Duration
                </th>
                <th scope="col" className="py-1 pr-3 text-right font-medium">
                  Cost
                </th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id} className="border-t border-border">
                  <td className="py-1.5 pr-3">
                    <button
                      type="button"
                      className="text-left text-accent underline-offset-2 hover:underline"
                      onClick={() => onOpen(run)}
                    >
                      {formatWhen(run.startedAt)}
                    </button>
                    {run.testMode && <span className="ml-2 text-caption text-fg-muted">Test</span>}
                  </td>
                  <td className="py-1.5 pr-3">
                    <RunStatusText status={run.status} />
                  </td>
                  <td className="py-1.5 pr-3 tabular-nums">
                    {formatDuration(run.startedAt, run.finishedAt)}
                  </td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{formatCost(run.costUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function AgentActivitySkeleton() {
  return (
    <div aria-busy="true" className="grid gap-2">
      <Skeleton className="h-6 w-full" />
      <Skeleton className="h-6 w-full" />
      <Skeleton className="h-6 w-full" />
    </div>
  );
}
