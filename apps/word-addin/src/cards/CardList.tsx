import { diffWords } from "@legallabs/docx";
import { Button, DiffView, StatusText, type Tone } from "@legallabs/ui";
import { useState } from "react";
import type { WordHost } from "../office/host.js";
import { type Card, type CardKind, type CardState, inDocumentOrder, KIND_LABEL } from "./card.js";

export type Decision = { card: Card; state: "applied" | "dismissed"; withComment: boolean };

const TONE: Record<CardKind, Tone> = {
  not_acceptable: "failed",
  needs_review: "warning",
  gap: "flagged",
  proofread: "external",
};

const commentOf = (card: Card) =>
  card.justification ? `${card.title}: ${card.justification}` : card.title;

function SuggestionCard({
  card,
  host,
  busy,
  onApply,
  onDismiss,
  onRerun,
}: {
  card: Card;
  host: WordHost;
  busy: boolean;
  onApply: (withComment: boolean) => void;
  onDismiss: () => void;
  onRerun?: (() => void) | undefined;
}) {
  const [copied, setCopied] = useState(false);
  const pending = card.state === "pending";
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(card.after);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <li
      className="grid gap-2 rounded-md border border-border bg-bg-raised p-3 data-[state=dismissed]:opacity-60"
      data-state={card.state}
      aria-label={`${KIND_LABEL[card.kind]}: ${card.title}`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <StatusText tone={TONE[card.kind]} className="text-dense">
          {KIND_LABEL[card.kind]}
        </StatusText>
        {card.before && (
          <Button size="sm" variant="quiet" onClick={() => void host.select(card.before)}>
            Go to
          </Button>
        )}
      </div>
      <p className="text-ui font-medium">{card.title}</p>
      <DiffView ops={diffWords(card.before, card.after)} className="text-ui" />
      {card.justification && <p className="text-dense text-fg-muted">{card.justification}</p>}
      {card.state === "applied" && (
        <StatusText tone="verified">Applied as a tracked change</StatusText>
      )}
      {card.state === "dismissed" && <p className="text-dense text-fg-muted">Dismissed</p>}
      {card.state === "anchor_failed" && (
        <div className="flex flex-wrap items-center gap-2">
          <StatusText tone="warning">Clause changed since review</StatusText>
          {onRerun && (
            <Button size="sm" variant="secondary" onClick={onRerun}>
              Re-run this rule
            </Button>
          )}
        </div>
      )}
      {pending && (
        <div className="flex flex-wrap gap-2">
          {host.capabilities.tracked ? (
            <>
              <Button size="sm" disabled={busy} onClick={() => onApply(false)}>
                Apply
              </Button>
              {host.capabilities.comments && (
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => onApply(true)}>
                  Apply with comment
                </Button>
              )}
            </>
          ) : (
            <Button size="sm" variant="secondary" onClick={() => void copy()}>
              {copied ? "Copied" : "Copy suggested text"}
            </Button>
          )}
          <Button size="sm" variant="quiet" disabled={busy} onClick={onDismiss}>
            Dismiss
          </Button>
        </div>
      )}
    </li>
  );
}

/** Suggestion cards under a sticky count, each applied as a real tracked change in Word. */
export function CardList({
  cards,
  host,
  onChange,
  onDecide,
  onRerun,
}: {
  cards: readonly Card[];
  host: WordHost;
  onChange: (id: string, state: CardState) => void;
  /** Tells the server what was decided; a failure here never undoes the edit in Word. */
  onDecide?: (decision: Decision) => Promise<void>;
  onRerun?: (card: Card) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [report, setReport] = useState<string | null>(null);
  const pending = cards.filter((c) => c.state === "pending");
  const applied = cards.filter((c) => c.state === "applied").length;

  const apply = async (card: Card, withComment: boolean): Promise<boolean> => {
    const result = await host.apply(
      {
        anchor: card.anchor,
        before: card.before,
        after: card.after,
        ...(withComment ? { comment: commentOf(card) } : {}),
      },
      true,
    );
    const state: CardState = result.ok ? "applied" : "anchor_failed";
    onChange(card.id, state);
    if (result.ok) await onDecide?.({ card, state: "applied", withComment }).catch(() => {});
    return result.ok;
  };

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setReport(null);
    try {
      await work();
    } catch {
      setReport("Word couldn't make that edit. Nothing else was changed.");
    } finally {
      setBusy(false);
    }
  };

  const applyAll = () =>
    run(async () => {
      setConfirming(false);
      let done = 0;
      for (const card of inDocumentOrder(pending)) {
        if (!(await apply(card, false))) {
          setReport(
            `Applied ${done}. Stopped at "${card.title}": the clause changed since review.`,
          );
          return;
        }
        done++;
      }
      setReport(`Applied ${done} as tracked changes.`);
    });

  const dismiss = (card: Card) => {
    onChange(card.id, "dismissed");
    void onDecide?.({ card, state: "dismissed", withComment: false }).catch(() => {});
  };

  if (cards.length === 0) return <p className="text-ui text-fg-muted">No suggestions.</p>;

  return (
    <section className="grid gap-2" aria-label="Suggestions">
      <header className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-2 border-b border-border bg-bg py-2">
        <p className="text-dense text-fg-muted tabular-nums">
          {cards.length} suggestions · {applied} applied
        </p>
        {host.capabilities.tracked && pending.length > 1 && !confirming && (
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => setConfirming(true)}>
            Apply all
          </Button>
        )}
        {confirming && (
          <div className="flex items-center gap-2">
            <span className="text-dense">Apply {pending.length} edits?</span>
            <Button size="sm" onClick={() => void applyAll()}>
              Yes, apply
            </Button>
            <Button size="sm" variant="quiet" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        )}
      </header>
      <p aria-live="polite" className="text-dense">
        {report}
      </p>
      <ol className="grid gap-2">
        {cards.map((card) => (
          <SuggestionCard
            key={card.id}
            card={card}
            host={host}
            busy={busy}
            onApply={(withComment) => void run(async () => void (await apply(card, withComment)))}
            onDismiss={() => dismiss(card)}
            onRerun={onRerun ? () => onRerun(card) : undefined}
          />
        ))}
      </ol>
    </section>
  );
}
