import { cn } from "../../cn.js";
import { CitationMarker } from "../evidence.js";
import { Skeleton } from "../status.js";
import { type AnswerCitation, type Range, splitAnswer } from "./answer.js";

const UNGROUNDED = "Not supported by a verified source";

/** An answer with its sources inline; text without a verified source is marked, never hidden. */
export function AnswerText({
  text,
  citations,
  ungrounded = [],
  onOpen,
  streaming = false,
  className,
}: {
  text: string;
  citations: readonly AnswerCitation[];
  ungrounded?: readonly Range[];
  onOpen: (n: number) => void;
  streaming?: boolean;
  className?: string;
}) {
  const parts = splitAnswer(text, citations, ungrounded);
  return (
    <div
      className={cn("max-w-[72ch] text-prose whitespace-pre-wrap text-fg", className)}
      aria-busy={streaming || undefined}
    >
      {parts.map((part, i) => {
        if (part.kind === "citation") {
          return (
            <CitationMarker
              key={`c${part.citation.n}`}
              evidence={part.citation}
              onOpen={() => onOpen(part.citation.n)}
            />
          );
        }
        if (part.kind === "pending") {
          return (
            <span
              key={`p${part.n}`}
              role="img"
              aria-label={`Source ${part.n}, checking`}
              className="mx-0.5 inline-flex h-[18px] min-w-[18px] -translate-y-0.5 animate-pulse items-center justify-center rounded-full border border-dashed border-control px-1 align-middle text-[11px] leading-none text-fg-muted tabular-nums"
            >
              {part.n}
            </span>
          );
        }
        if (!part.ungrounded) {
          // biome-ignore lint/suspicious/noArrayIndexKey: runs have no identity beyond position
          return <span key={i}>{part.text}</span>;
        }
        return (
          // A dotted underline as well as colour, so the flag survives without colour vision.
          <mark
            // biome-ignore lint/suspicious/noArrayIndexKey: runs have no identity beyond position
            key={i}
            title={UNGROUNDED}
            className="border-l-2 border-fg-muted bg-transparent pl-1 text-fg underline decoration-fg-muted decoration-dotted underline-offset-4"
          >
            {part.text}
            <span className="sr-only"> ({UNGROUNDED})</span>
          </mark>
        );
      })}
      {streaming && (
        <span
          aria-hidden
          className="ml-0.5 inline-block h-[1em] w-0.5 animate-pulse bg-fg align-text-bottom"
        />
      )}
    </div>
  );
}

/** Lines the size of an answer, so nothing jumps when the first words arrive. */
export function AnswerTextSkeleton() {
  return (
    <div className="grid max-w-[72ch] gap-2" aria-hidden>
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-11/12" />
      <Skeleton className="h-4 w-2/3" />
    </div>
  );
}
