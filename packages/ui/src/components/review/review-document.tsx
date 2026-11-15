import type { Suggestion } from "@legallabs/contracts";
import { type ReactNode, useEffect, useId, useRef } from "react";
import { cn } from "../../cn.js";
import { Skeleton } from "../status.js";
import { type ReviewItem, suggestionOf } from "./order.js";
import { titleOf } from "./suggestion-card.js";

/** A body paragraph as the review indexed it; `index` is what evidence and anchors name. */
export type ReviewParagraph = {
  index: number;
  text: string;
  section_path?: string;
  /** Headers, footers, fields and the like: shown, never edited. */
  excluded: boolean;
};

type Mark = {
  from: number;
  to: number;
  itemId: string;
  label: string;
  /** Set for an edit; evidence marks carry none. */
  suggestion?: Suggestion;
};

const shown = (s: Suggestion | undefined): s is Suggestion =>
  s !== undefined && (s.status === "pending" || s.status === "applied");

/** Marks per paragraph; edits win over evidence where they overlap. */
export function marksByParagraph(items: readonly ReviewItem[]): Map<number, Mark[]> {
  const all = new Map<number, Mark[]>();
  const add = (p: number, mark: Mark) => all.set(p, [...(all.get(p) ?? []), mark]);
  for (const item of items) {
    const label = titleOf(item);
    const s = suggestionOf(item);
    if (shown(s) && s.kind === "replace") {
      add(s.anchor.paragraph_index, {
        from: s.anchor.char_from,
        to: s.anchor.char_to,
        itemId: item.id,
        label,
        suggestion: s,
      });
    }
    const evidence = item.kind === "rule" ? item.finding.evidence : item.gap.evidence;
    for (const e of evidence) {
      if (e.verified !== "ok" || e.char_to <= e.char_from) continue;
      add(e.paragraph_index, { from: e.char_from, to: e.char_to, itemId: item.id, label });
    }
  }
  for (const [p, marks] of all) {
    const sorted = [...marks].sort(
      (a, b) => Number(Boolean(b.suggestion)) - Number(Boolean(a.suggestion)) || a.from - b.from,
    );
    const kept: Mark[] = [];
    for (const m of sorted) if (!kept.some((k) => m.from < k.to && k.from < m.to)) kept.push(m);
    all.set(
      p,
      kept.sort((a, b) => a.from - b.from),
    );
  }
  return all;
}

/**
 * The contract as the review read it, with evidence highlighted and edits shown as
 * tracked changes: applied ones struck and inserted, pending ones marked as proposed.
 */
export function ReviewDocument({
  paragraphs,
  items,
  selectedId,
  onSelect,
  focus,
  showJustifications = false,
  className,
}: {
  paragraphs: readonly ReviewParagraph[];
  items: readonly ReviewItem[];
  selectedId?: string | null;
  onSelect?: (itemId: string) => void;
  /** Scrolls to a paragraph; a new object scrolls again to the same one. */
  focus?: { paragraph: number } | null;
  showJustifications?: boolean;
  className?: string;
}) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const marks = marksByParagraph(items);

  useEffect(() => {
    if (!focus) return;
    root.current
      ?.querySelector(`[data-paragraph="${focus.paragraph}"]`)
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [focus]);

  // Notes and inserted clauses hang off the paragraph the edit or first evidence names.
  const notes = new Map<number, { item: ReviewItem; text: string }[]>();
  const inserts = new Map<number, { item: ReviewItem; suggestion: Suggestion }[]>();
  for (const item of items) {
    const s = suggestionOf(item);
    if (shown(s) && s.kind === "insert_after") {
      const at = s.anchor.paragraph_index;
      inserts.set(at, [...(inserts.get(at) ?? []), { item, suggestion: s }]);
    }
    if (showJustifications && shown(s) && s.justification) {
      const at = s.anchor.paragraph_index;
      notes.set(at, [...(notes.get(at) ?? []), { item, text: s.justification }]);
    }
  }

  return (
    <div
      ref={root}
      aria-label="Contract"
      role="document"
      className={cn(
        "mx-auto grid max-w-[72ch] gap-3 rounded-lg border border-border bg-bg-raised px-8 py-6 font-serif text-[15px] leading-relaxed",
        className,
      )}
    >
      {paragraphs.map((p) => (
        <div key={p.index} className="grid gap-2">
          <p
            id={`${id}-p-${p.index}`}
            data-paragraph={p.index}
            className={cn(
              "scroll-mt-16 whitespace-pre-wrap",
              p.excluded && "text-caption text-fg-muted italic",
            )}
          >
            {segments(p, marks.get(p.index) ?? [], selectedId ?? null, onSelect)}
            {p.excluded && <span className="sr-only"> (not reviewed for edits)</span>}
          </p>
          {(inserts.get(p.index) ?? []).map(({ item, suggestion }) => (
            <p key={suggestion.id} className="whitespace-pre-wrap">
              <Tracked
                selected={selectedId === item.id}
                label={titleOf(item)}
                onSelect={onSelect && (() => onSelect(item.id))}
              >
                <ins
                  className={cn(
                    "underline underline-offset-2",
                    suggestion.status === "applied"
                      ? "text-verified"
                      : "text-accent decoration-dashed",
                  )}
                >
                  {suggestion.after}
                </ins>
              </Tracked>
            </p>
          ))}
          {(notes.get(p.index) ?? []).map(({ item, text }) => (
            <aside
              key={item.id}
              aria-label={`Justification: ${titleOf(item)}`}
              className="ml-6 rounded-md border-l-2 border-accent bg-bg px-3 py-2 font-sans text-dense"
            >
              <span className="font-semibold">{titleOf(item)}: </span>
              {text}
            </aside>
          ))}
        </div>
      ))}
    </div>
  );
}

function segments(
  p: ReviewParagraph,
  marks: readonly Mark[],
  selectedId: string | null,
  onSelect: ((itemId: string) => void) | undefined,
): ReactNode[] {
  const out: ReactNode[] = [];
  let at = 0;
  for (const m of marks) {
    if (m.from < at || m.to > p.text.length) continue;
    if (m.from > at) out.push(p.text.slice(at, m.from));
    const text = p.text.slice(m.from, m.to);
    const s = m.suggestion;
    out.push(
      <Tracked
        key={`${m.itemId}-${m.from}`}
        selected={selectedId === m.itemId}
        label={m.label}
        onSelect={onSelect && (() => onSelect(m.itemId))}
      >
        {s?.status === "applied" ? (
          <>
            <del className="text-destructive">{text}</del>
            <ins className="text-verified underline underline-offset-2">{s.after}</ins>
          </>
        ) : s ? (
          <span className="underline decoration-accent decoration-dashed underline-offset-4">
            {text}
          </span>
        ) : (
          <mark className="rounded-sm bg-[color-mix(in_oklab,var(--color-citation)_18%,transparent)] text-fg">
            {text}
          </mark>
        )}
      </Tracked>,
    );
    at = m.to;
  }
  if (at < p.text.length) out.push(p.text.slice(at));
  return out;
}

function Tracked({
  selected,
  label,
  onSelect,
  children,
}: {
  selected: boolean;
  label: string;
  onSelect: (() => void) | undefined;
  children: ReactNode;
}) {
  const ring = selected ? "outline-2 outline-offset-2 outline-accent rounded-sm" : "";
  if (!onSelect) return <span className={ring}>{children}</span>;
  return (
    <button
      type="button"
      title={label}
      aria-pressed={selected}
      onClick={onSelect}
      className={cn("inline cursor-pointer text-left", ring)}
    >
      {children}
    </button>
  );
}

export function ReviewDocumentSkeleton() {
  return (
    <div
      aria-busy="true"
      className="mx-auto grid w-full max-w-[72ch] gap-3 rounded-lg border border-border px-8 py-6"
    >
      <span className="sr-only">Loading the contract…</span>
      <Skeleton className="h-6 w-1/2" />
      {[0, 1, 2, 3, 4].map((i) => (
        <Skeleton key={i} className="h-16" />
      ))}
    </div>
  );
}
