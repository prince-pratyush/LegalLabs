import type { LucideIcon } from "lucide-react";
import { Button } from "../button.js";
import { EmptyState } from "../empty-state.js";
import { Skeleton } from "../status.js";

export type LibraryAction = { label: string; onClick: () => void; primary?: boolean };

export type LibraryEntry = {
  id: string;
  name: string;
  description?: string | null;
  /** One quiet line, e.g. "Ana Silva · updated 2 Nov". */
  meta: string;
  badges?: string[];
  actions: LibraryAction[];
};

/** Saved prompts or firm templates, one row each, actions at the end. */
export function LibraryList({
  label,
  entries,
  empty,
}: {
  label: string;
  entries: LibraryEntry[];
  empty: { icon?: LucideIcon; title: string; description: string; action: LibraryAction };
}) {
  if (entries.length === 0) {
    return (
      <EmptyState
        {...(empty.icon ? { icon: empty.icon } : {})}
        title={empty.title}
        description={empty.description}
        action={empty.action}
      />
    );
  }
  return (
    <ul aria-label={label} className="grid divide-y divide-border border-y border-border">
      {entries.map((entry) => (
        <li key={entry.id} className="flex flex-wrap items-start gap-x-4 gap-y-2 py-3">
          <div className="grid min-w-0 flex-1 gap-0.5">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="truncate text-ui font-semibold text-fg">{entry.name}</h3>
              {entry.badges?.map((badge) => (
                <span
                  key={badge}
                  className="rounded-sm border border-border px-1.5 text-caption text-fg-muted"
                >
                  {badge}
                </span>
              ))}
            </div>
            {entry.description && (
              <p className="line-clamp-2 text-dense text-fg-muted">{entry.description}</p>
            )}
            <p className="text-caption text-fg-muted">{entry.meta}</p>
          </div>
          <div className="flex flex-wrap gap-1">
            {entry.actions.map((action) => (
              <Button
                key={action.label}
                size="sm"
                variant={action.primary ? "primary" : "quiet"}
                onClick={action.onClick}
                aria-label={`${action.label}: ${entry.name}`}
              >
                {action.label}
              </Button>
            ))}
          </div>
        </li>
      ))}
    </ul>
  );
}

export function LibraryListSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div role="status" aria-label="Loading the Library" className="grid gap-4 py-3">
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: placeholders have no identity.
        <div key={i} className="grid gap-1.5">
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-3 w-80 max-w-full" />
          <Skeleton className="h-3 w-32" />
        </div>
      ))}
    </div>
  );
}
