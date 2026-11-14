import { FileText } from "lucide-react";
import { cn } from "../../cn.js";
import { clip } from "../evidence.js";
import { Skeleton, StatusText } from "../status.js";
import type { AnswerCitation } from "./answer.js";

const UNKNOWN = "Unknown document";

/** Document, then page, then citation number: the order a lawyer checks them in. */
export function groupSources(citations: readonly AnswerCitation[]) {
  const docs = new Map<string, AnswerCitation[]>();
  for (const citation of citations) {
    const key = citation.documentName ?? UNKNOWN;
    const list = docs.get(key);
    if (list) list.push(citation);
    else docs.set(key, [citation]);
  }
  return [...docs].map(([name, list]) => ({
    name,
    citations: [...list].sort((a, b) => (a.page ?? 0) - (b.page ?? 0) || a.n - b.n),
  }));
}

export function SourcesList({
  citations,
  onOpen,
  onFlagged,
  activeN,
  className,
}: {
  citations: readonly AnswerCitation[];
  /** Verified sources only: opens the viewer at the span. */
  onOpen: (n: number) => void;
  /** Unverified sources, e.g. to search the document for the quote. Static rows when absent. */
  onFlagged?: (n: number) => void;
  activeN?: number;
  className?: string;
}) {
  if (citations.length === 0) {
    return (
      <p className={cn("px-3 py-6 text-center text-ui text-fg-muted", className)}>
        This answer has no sources yet.
      </p>
    );
  }
  return (
    <div className={cn("grid gap-4", className)}>
      {groupSources(citations).map((group) => (
        <section key={group.name} aria-label={group.name} className="grid gap-1">
          <h3 className="flex items-center gap-1.5 text-dense font-semibold text-fg">
            <FileText aria-hidden className="size-4 text-fg-muted" strokeWidth={1.5} />
            <span className="truncate">{group.name}</span>
          </h3>
          <ul className="grid gap-1">
            {group.citations.map((citation) => {
              const ok = citation.status === "ok";
              const body = (
                <>
                  <span className="flex items-baseline justify-between gap-2 text-caption">
                    <span className="font-semibold tabular-nums">[{citation.n}]</span>
                    <span className="text-fg-muted tabular-nums">
                      {citation.page === null ? "No page" : `Page ${citation.page}`}
                    </span>
                    <StatusText tone={ok ? "verified" : "flagged"} className="ml-auto">
                      {ok ? "Verified" : "Not verified"}
                    </StatusText>
                  </span>
                  {!ok && (
                    <span className="text-caption text-fg-muted">Couldn't verify on the page</span>
                  )}
                  <span
                    className={cn(
                      "border-l-2 pl-2 text-dense text-fg",
                      ok ? "border-citation" : "border-dashed border-flagged",
                    )}
                  >
                    {citation.quote ? clip(citation.quote, 240) : "No quote given"}
                  </span>
                </>
              );
              const row =
                "grid w-full gap-1 rounded-md px-2 py-1.5 text-left aria-current:tint-selected";
              // Only a verified source opens at its span; a flagged one must not look like one.
              const action = ok
                ? () => onOpen(citation.n)
                : onFlagged && (() => onFlagged(citation.n));
              return (
                <li key={citation.n}>
                  {action ? (
                    <button
                      type="button"
                      onClick={action}
                      aria-current={activeN === citation.n || undefined}
                      className={cn(row, "hover:tint-hover")}
                    >
                      {body}
                    </button>
                  ) : (
                    <div aria-current={activeN === citation.n || undefined} className={row}>
                      {body}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

export function SourcesListSkeleton() {
  return (
    <div className="grid gap-3" aria-hidden>
      <Skeleton className="h-4 w-1/2" />
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-10 w-full" />
    </div>
  );
}
