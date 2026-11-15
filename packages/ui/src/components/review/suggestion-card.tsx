import type { Evidence, Suggestion } from "@legallabs/contracts";
import { CornerDownRight } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { cn } from "../../cn.js";
import { Button } from "../button.js";
import { clip } from "../evidence.js";
import { Input } from "../field.js";
import { Skeleton } from "../status.js";
import { type ReviewItem, suggestionOf } from "./order.js";
import { FindingStatusText, GapSeverityText, SuggestionStatusText } from "./status.js";

/** Another wording for a suggestion, as the alternates call returns it. */
export type Alternate = { id: string; after: string; justification: string };

export type ApplyChoice = { withComment: boolean; alternateId?: string };

export type CardActions = {
  onGoTo?: (paragraphIndex: number) => void;
  onApply?: (suggestion: Suggestion, choice: ApplyChoice) => void;
  onDismiss?: (suggestion: Suggestion) => void;
  onRevise?: (suggestion: Suggestion, instruction: string) => void;
  onAlternates?: (suggestion: Suggestion) => void;
  /** Offered when the clause changed since the review, so the rule can run again. */
  onRerun?: (ruleId: string) => void;
};

export const titleOf = (item: ReviewItem) =>
  item.kind === "rule"
    ? item.finding.rule_title
    : item.gap.kind === "existing_edit"
      ? "Existing edit outside the playbook"
      : "Clause outside the playbook";

const sectionOf = (evidence: readonly Evidence[]) =>
  evidence.find((e) => e.section_path)?.section_path;

/**
 * One rule's finding or one gap, with its suggested edit and the decisions on it.
 * Words carry the status, so nothing depends on colour.
 */
export function SuggestionCard({
  item,
  selected = false,
  showJustification = false,
  busy = false,
  alternates,
  onSelect,
  ...actions
}: {
  item: ReviewItem;
  selected?: boolean;
  /** Opens every justification at once, as the rail's toggle asks. */
  showJustification?: boolean;
  /** A decision on this card is being saved. */
  busy?: boolean;
  /** Undefined until asked for; null while they load. */
  alternates?: readonly Alternate[] | null;
  onSelect?: () => void;
} & CardActions) {
  const headingId = useId();
  const [revising, setRevising] = useState(false);
  const [instruction, setInstruction] = useState("");
  const suggestion = suggestionOf(item);
  const evidence = item.kind === "rule" ? item.finding.evidence : item.gap.evidence;
  const section = sectionOf(evidence);
  const pending = suggestion?.status === "pending";
  const why = suggestion?.justification;

  const revise = (event: FormEvent) => {
    event.preventDefault();
    if (!suggestion || !instruction.trim()) return;
    actions.onRevise?.(suggestion, instruction.trim());
    setRevising(false);
    setInstruction("");
  };

  return (
    <article
      aria-labelledby={headingId}
      data-selected={selected || undefined}
      className={cn(
        "grid gap-3 rounded-lg border border-border bg-bg-raised p-3 text-ui",
        selected && "border-accent ring-1 ring-accent",
      )}
    >
      <header className="grid gap-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {item.kind === "rule" ? (
            <FindingStatusText status={item.finding.status} />
          ) : (
            <GapSeverityText severity={item.gap.severity} />
          )}
          {item.kind === "rule" && item.finding.flag && (
            <span className="text-caption font-medium text-fg-muted uppercase">Flagged rule</span>
          )}
          {section && <span className="text-caption text-fg-muted">§{section}</span>}
        </div>
        <h3 id={headingId} className="font-semibold">
          {onSelect ? (
            <button type="button" className="text-left hover:underline" onClick={onSelect}>
              {titleOf(item)}
            </button>
          ) : (
            titleOf(item)
          )}
        </h3>
      </header>

      {(item.kind === "rule" ? item.finding.explanation : item.gap.reason) && (
        <p>{item.kind === "rule" ? item.finding.explanation : item.gap.reason}</p>
      )}
      {item.kind === "rule" && item.finding.verification !== "ok" && (
        <p className="text-caption text-flagged">
          The quoted evidence could not be matched to the document. Check it by hand.
        </p>
      )}

      {evidence.length > 0 && (
        <ul className="grid gap-1">
          {evidence.map((e) => (
            <li key={`${e.paragraph_index}-${e.char_from}`} className="flex items-start gap-2">
              <blockquote
                className={cn(
                  "min-w-0 flex-1 border-l-2 pl-2 text-fg-muted",
                  e.verified === "ok" ? "border-citation" : "border-dashed border-flagged",
                )}
              >
                {clip(e.quote, 280)}
              </blockquote>
              {actions.onGoTo && (
                <Button
                  variant="quiet"
                  size="sm"
                  aria-label={`Go to ${section ? `§${e.section_path ?? section}` : "the clause"}`}
                  onClick={() => actions.onGoTo?.(e.paragraph_index)}
                >
                  <CornerDownRight aria-hidden />
                  Go to
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {suggestion && suggestion.status !== "superseded" && (
        <div className="grid gap-1">
          <h4 className="text-caption font-semibold text-fg-muted uppercase">
            {suggestion.kind === "insert_after" ? "Clause to add" : "Recommended language"}
          </h4>
          <p className="rounded-md border border-border bg-bg p-2 leading-relaxed">
            {suggestion.before && (
              <>
                <del className="text-destructive">{suggestion.before}</del>{" "}
              </>
            )}
            <ins className="text-verified underline underline-offset-2">{suggestion.after}</ins>
          </p>
        </div>
      )}

      {why &&
        (showJustification ? (
          <p className="border-l-2 border-accent pl-2">
            <span className="font-medium">Justification. </span>
            {why}
          </p>
        ) : (
          <details>
            <summary className="cursor-pointer font-medium">Justification</summary>
            <p className="mt-1 border-l-2 border-accent pl-2">{why}</p>
          </details>
        ))}

      {suggestion && !pending && (
        <p className="flex flex-wrap items-center gap-2">
          <SuggestionStatusText status={suggestion.status} />
          {suggestion.status === "applied" && suggestion.applied_with_comment && (
            <span className="text-caption text-fg-muted">with a comment</span>
          )}
          {suggestion.status === "anchor_failed" && item.kind === "rule" && actions.onRerun && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => actions.onRerun?.(item.finding.rule_id)}
            >
              Re-run this rule
            </Button>
          )}
        </p>
      )}

      {suggestion && pending && (
        <div className="grid gap-2">
          <div className="flex flex-wrap gap-2" aria-busy={busy}>
            <Button
              size="sm"
              disabled={busy}
              onClick={() => actions.onApply?.(suggestion, { withComment: false })}
            >
              Apply
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => actions.onApply?.(suggestion, { withComment: true })}
            >
              Apply with comment
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              aria-expanded={revising}
              onClick={() => setRevising((on) => !on)}
            >
              Revise
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy || alternates !== undefined}
              onClick={() => actions.onAlternates?.(suggestion)}
            >
              Alternates
            </Button>
            <Button
              size="sm"
              variant="quiet"
              disabled={busy}
              onClick={() => actions.onDismiss?.(suggestion)}
            >
              Dismiss
            </Button>
          </div>
          {revising && (
            <form className="flex gap-2" onSubmit={revise}>
              <Input
                aria-label="How should it change?"
                placeholder="Such as: use the 18-month fallback"
                value={instruction}
                maxLength={2000}
                onChange={(e) => setInstruction(e.target.value)}
              />
              <Button type="submit" size="sm" disabled={busy || !instruction.trim()}>
                Revise
              </Button>
            </form>
          )}
          {alternates === null && (
            <div aria-busy="true" className="grid gap-1">
              <span className="sr-only">Loading alternates…</span>
              <Skeleton className="h-10" />
              <Skeleton className="h-10" />
            </div>
          )}
          {alternates && (
            <div className="grid gap-2">
              {alternates.length === 0 && (
                <p className="text-fg-muted">No other wording was found for this rule.</p>
              )}
              {alternates.map((alt, i) => (
                <div key={alt.id} className="grid gap-1 rounded-md border border-border p-2">
                  <p className="text-caption font-medium text-fg-muted">Alternate {i + 1}</p>
                  <p>{alt.after}</p>
                  {alt.justification && (
                    <p className="text-caption text-fg-muted">{alt.justification}</p>
                  )}
                  <div>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy}
                      onClick={() =>
                        actions.onApply?.(suggestion, { withComment: false, alternateId: alt.id })
                      }
                    >
                      Apply alternate {i + 1}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </article>
  );
}

export function SuggestionCardSkeleton() {
  return (
    <div aria-busy="true" className="grid gap-2 rounded-lg border border-border p-3">
      <span className="sr-only">Loading…</span>
      <Skeleton className="h-5 w-32" />
      <Skeleton className="h-5 w-48" />
      <Skeleton className="h-12" />
      <Skeleton className="h-7 w-64" />
    </div>
  );
}
