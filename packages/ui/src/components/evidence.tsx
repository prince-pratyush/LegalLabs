import { Tooltip as Primitive } from "radix-ui";
import { cn } from "../cn.js";
import { StatusText } from "./status.js";
import { Kbd, tooltipSurface } from "./tooltip.js";

export type EvidenceStatus = "ok" | "mismatch" | "unresolved";

export type Evidence = {
  n: number;
  status: EvidenceStatus;
  documentName: string | null;
  page: number | null;
  quote: string | null;
};

const QUOTE_LIMIT = 400;

export const clip = (quote: string, limit = QUOTE_LIMIT) =>
  quote.length <= limit ? quote : `${quote.slice(0, limit - 1).trimEnd()}…`;

const verified = (status: EvidenceStatus) => status === "ok";

/** The one way a source is shown, so threads, cells and tasks all verify alike. */
export function CitationMarker({
  evidence,
  onOpen,
  defaultOpen,
  className,
}: {
  evidence: Evidence;
  onOpen: (evidence: Evidence) => void;
  defaultOpen?: boolean;
  className?: string;
}) {
  const ok = verified(evidence.status);
  return (
    <Primitive.Provider delayDuration={150}>
      <Primitive.Root {...(defaultOpen ? { defaultOpen } : {})}>
        <Primitive.Trigger asChild>
          <button
            type="button"
            data-status={evidence.status}
            aria-label={`Source ${evidence.n}, ${ok ? "verified" : "not verified"}`}
            onClick={() => onOpen(evidence)}
            className={cn(
              "mx-0.5 inline-flex h-[18px] min-w-[18px] -translate-y-0.5 items-center justify-center rounded-full border px-1 align-middle text-[11px] leading-none font-semibold tabular-nums transition-colors duration-(--motion-fast)",
              ok
                ? "border-citation text-citation hover:bg-citation hover:text-bg"
                : "border-dashed border-flagged text-flagged hover:tint-hover",
              className,
            )}
          >
            {evidence.n}
            {ok ? "" : "!"}
          </button>
        </Primitive.Trigger>
        <Primitive.Portal>
          <Primitive.Content
            side="top"
            sideOffset={6}
            collisionPadding={8}
            className={cn(tooltipSurface, "grid w-80 gap-2 p-3 text-ui")}
          >
            <p className="flex items-baseline justify-between gap-2">
              <span className="truncate font-medium">
                {evidence.documentName ?? "Unknown document"}
              </span>
              <span className="shrink-0 text-caption text-fg-muted tabular-nums">
                {evidence.page === null ? "No page given" : `Page ${evidence.page}`}
              </span>
            </p>
            <blockquote className="border-l-2 border-citation pl-2 text-fg">
              {evidence.quote ? clip(evidence.quote) : "No quote given"}
            </blockquote>
            <p className="flex items-center justify-between gap-2 text-caption">
              <StatusText tone={ok ? "verified" : "flagged"}>
                {ok ? "Verified on the page" : "Not verified"}
              </StatusText>
              <span className="text-fg-muted">
                <Kbd>Enter</Kbd> opens the source
              </span>
            </p>
          </Primitive.Content>
        </Primitive.Portal>
      </Primitive.Root>
    </Primitive.Provider>
  );
}
