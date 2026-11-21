import { Bot } from "lucide-react";
import { EmptyState } from "../empty-state.js";
import { Skeleton } from "../status.js";
import { AccessBadge, AgentStatusBadge, ScheduleBadge } from "./agent-badges.js";
import { type AccessLevel, formatWhen } from "./types.js";

export type AgentRow = {
  id: string;
  title: string;
  description: string;
  practiceAreas: string[];
  status: "draft" | "live";
  access: AccessLevel;
  mine: boolean;
  runs: number;
  schedule: { paused: boolean; nextRunAt: string | null } | null;
};

/** Agents as a plain list: a page holds few enough that scanning beats a grid. */
export function AgentList({
  rows,
  loading = false,
  filtered = false,
  onOpen,
  onCreate,
}: {
  rows: readonly AgentRow[];
  loading?: boolean;
  /** A filter or search is on, so empty means "no match", not "none yet". */
  filtered?: boolean;
  onOpen: (row: AgentRow) => void;
  onCreate: () => void;
}) {
  if (loading) return <AgentListSkeleton />;
  if (rows.length === 0) {
    return filtered ? (
      <p className="py-8 text-center text-ui text-fg-muted">No agents match these filters.</p>
    ) : (
      <EmptyState
        icon={Bot}
        title="No agents yet"
        description="An agent is a saved set of instructions, files and sources you can run again and again, or on a schedule."
        action={{ label: "Create an agent", onClick: onCreate }}
      />
    );
  }
  return (
    <ul aria-label="Agents" className="grid divide-y divide-border rounded-lg border border-border">
      {rows.map((row) => (
        <li key={row.id}>
          <button
            type="button"
            onClick={() => onOpen(row)}
            className="grid w-full gap-1 px-4 py-3 text-left hover:tint-hover focus-visible:tint-selected"
          >
            <span className="flex flex-wrap items-center gap-2">
              <span className="text-ui font-semibold text-fg">{row.title}</span>
              <AgentStatusBadge status={row.status} />
              {!row.mine && <AccessBadge level={row.access} />}
              {row.schedule && <ScheduleBadge paused={row.schedule.paused} />}
            </span>
            {row.description && (
              <span className="line-clamp-2 text-dense text-fg-muted">{row.description}</span>
            )}
            <span className="flex flex-wrap gap-x-3 text-caption text-fg-muted">
              {row.practiceAreas.length > 0 && <span>{row.practiceAreas.join(", ")}</span>}
              <span>
                {row.runs} {row.runs === 1 ? "run" : "runs"}
              </span>
              {row.schedule?.nextRunAt && !row.schedule.paused && (
                <span>Next run {formatWhen(row.schedule.nextRunAt)}</span>
              )}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function AgentListSkeleton() {
  return (
    <div aria-busy="true" className="grid gap-3 rounded-lg border border-border p-4">
      <Skeleton className="h-5 w-1/3" />
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-5 w-1/4" />
      <Skeleton className="h-4 w-1/2" />
    </div>
  );
}
