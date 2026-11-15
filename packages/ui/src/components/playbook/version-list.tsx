import type { PlaybookVersion } from "@legallabs/contracts";
import { Button } from "../button.js";
import { Skeleton } from "../status.js";

const when = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });

/** Saved versions, newest first; reviews name the version they ran against. */
export function VersionList({
  versions,
  current,
  viewing,
  onView,
  authorName = () => null,
}: {
  versions: readonly PlaybookVersion[];
  /** The live version number. */
  current: number;
  /** The version on screen, when it isn't the live one. */
  viewing?: number | null;
  onView: (no: number) => void;
  authorName?: (userId: string) => string | null;
}) {
  return (
    <section aria-labelledby="playbook-versions" className="grid gap-2">
      <h2 id="playbook-versions" className="text-caption font-semibold text-fg-muted uppercase">
        Versions
      </h2>
      <ol className="grid gap-1">
        {versions.map((v) => {
          const shown = (viewing ?? current) === v.no;
          const by = authorName(v.created_by);
          return (
            <li key={v.version_id}>
              <Button
                variant="quiet"
                size="sm"
                className="h-auto w-full flex-col items-start gap-0 py-1 aria-[current=true]:tint-selected"
                aria-current={shown ? "true" : undefined}
                onClick={() => onView(v.no)}
              >
                <span>
                  Version {v.no}
                  {v.no === current ? " (current)" : ""}
                </span>
                <span className="text-caption font-normal text-fg-muted">
                  {when.format(new Date(v.created_at))} · {v.rule_count} rules
                  {by ? ` · ${by}` : ""}
                </span>
              </Button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

export function VersionListSkeleton() {
  return (
    <div aria-hidden className="grid gap-2">
      <Skeleton className="h-4 w-20" />
      <Skeleton className="h-9" />
      <Skeleton className="h-9" />
    </div>
  );
}
