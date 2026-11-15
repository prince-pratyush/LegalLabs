import type { Review } from "@legallabs/contracts";
import { Download, FileSpreadsheet, FileText } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "../button.js";
import { Checkbox } from "../checkbox.js";
import { Skeleton, StatusText } from "../status.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../tabs.js";
import {
  gapsView,
  pendingSuggestions,
  type ReviewItem,
  rulesView,
  suggestionOf,
  suggestionsView,
  summaryLine,
} from "./order.js";
import { type Alternate, type CardActions, SuggestionCard } from "./suggestion-card.js";

export type RailView = "rules" | "suggestions";

/**
 * The cards beside the contract: a Rules view in document order and a Suggestions view of
 * edits only, the gaps no rule covers, and the downloads.
 */
export function ReviewRail({
  review,
  kind,
  view,
  onViewChange,
  showJustifications,
  onShowJustifications,
  selectedId,
  onSelect,
  busyIds,
  alternates = {},
  onApplyAll,
  onDownloadRedline,
  onExport,
  downloading = null,
  ...actions
}: {
  review: Pick<Review, "results" | "gaps" | "summary" | "status" | "warnings">;
  /** The reviewed file: redlines need the Word file. */
  kind: "docx" | "pdf";
  view: RailView;
  onViewChange: (view: RailView) => void;
  showJustifications: boolean;
  onShowJustifications: (on: boolean) => void;
  selectedId?: string | null;
  onSelect?: (item: ReviewItem) => void;
  /** Suggestions with a decision being saved. */
  busyIds?: ReadonlySet<string>;
  /** Alternates by suggestion id; null while loading. */
  alternates?: Readonly<Record<string, readonly Alternate[] | null>>;
  onApplyAll?: (withComment: boolean) => void;
  onDownloadRedline?: (includePending: boolean) => void;
  onExport?: (format: "docx" | "xlsx") => void;
  /** Which download is being made. */
  downloading?: "redline" | "docx" | "xlsx" | null;
} & CardActions) {
  const id = useId();
  const [confirming, setConfirming] = useState(false);
  const [withComment, setWithComment] = useState(false);
  const [includePending, setIncludePending] = useState(true);
  const pending = pendingSuggestions(review.results, review.gaps);
  const finished = review.status === "done" || review.status === "cancelled";

  const card = (item: ReviewItem) => {
    const s = suggestionOf(item);
    return (
      <li key={item.id}>
        <SuggestionCard
          item={item}
          selected={selectedId === item.id}
          showJustification={showJustifications}
          busy={s ? (busyIds?.has(s.id) ?? false) : false}
          {...(s && alternates[s.id] !== undefined ? { alternates: alternates[s.id] } : {})}
          {...(onSelect ? { onSelect: () => onSelect(item) } : {})}
          {...actions}
        />
      </li>
    );
  };

  return (
    <section aria-label="Review results" className="grid content-start gap-4">
      <header className="grid gap-3">
        <p className="text-dense font-medium tabular-nums">{summaryLine(review.summary)}</p>
        {review.warnings.includes("over_100_pages") && (
          <StatusText tone="warning">
            Over 100 pages: results are slower and less accurate.
          </StatusText>
        )}
        {review.warnings.includes("partial_coverage") && (
          <StatusText tone="flagged">Some paragraphs were not read by any check.</StatusText>
        )}
        {kind === "pdf" && (
          <p className="text-fg-muted">
            Redlines need the Word file. This PDF gives findings and a summary only.
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {onApplyAll && pending.length > 0 && !confirming && (
            <Button size="sm" onClick={() => setConfirming(true)}>
              Apply all ({pending.length})
            </Button>
          )}
          {kind === "docx" && onDownloadRedline && (
            <Button
              size="sm"
              variant="secondary"
              disabled={!finished || downloading !== null}
              onClick={() => onDownloadRedline(includePending)}
            >
              <Download aria-hidden />
              {downloading === "redline" ? "Preparing…" : "Download redline"}
            </Button>
          )}
          {onExport &&
            (["docx", "xlsx"] as const).map((format) => (
              <Button
                key={format}
                size="sm"
                variant="secondary"
                disabled={!finished || downloading !== null}
                onClick={() => onExport(format)}
              >
                {format === "docx" ? <FileText aria-hidden /> : <FileSpreadsheet aria-hidden />}
                {downloading === format ? "Preparing…" : `Export summary (.${format})`}
              </Button>
            ))}
        </div>

        {confirming && onApplyAll && (
          <fieldset
            aria-label="Apply all suggestions"
            className="grid gap-2 rounded-md border border-border p-3"
          >
            <p>
              Apply {pending.length === 1 ? "1 suggestion" : `${pending.length} suggestions`} in
              document order? Dismissed ones are left out.
            </p>
            <div className="flex items-center gap-1">
              <Checkbox
                id={`${id}-comment`}
                checked={withComment}
                onCheckedChange={(on) => setWithComment(on === true)}
              />
              <label htmlFor={`${id}-comment`}>Add each justification as a comment</label>
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={() => {
                  setConfirming(false);
                  onApplyAll(withComment);
                }}
              >
                Apply {pending.length}
              </Button>
              <Button size="sm" variant="quiet" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </div>
          </fieldset>
        )}

        <div className="flex flex-wrap gap-x-4 gap-y-1">
          <div className="flex items-center gap-1">
            <Checkbox
              id={`${id}-why`}
              checked={showJustifications}
              onCheckedChange={(on) => onShowJustifications(on === true)}
            />
            <label htmlFor={`${id}-why`}>Show justifications</label>
          </div>
          {kind === "docx" && onDownloadRedline && (
            <div className="flex items-center gap-1">
              <Checkbox
                id={`${id}-pending`}
                checked={includePending}
                onCheckedChange={(on) => setIncludePending(on === true)}
              />
              <label htmlFor={`${id}-pending`}>Include undecided suggestions in the redline</label>
            </div>
          )}
        </div>
      </header>

      <Tabs value={view} onValueChange={(v) => onViewChange(v as RailView)}>
        <TabsList aria-label="Order results by">
          <TabsTrigger value="rules">Rules</TabsTrigger>
          <TabsTrigger value="suggestions">Suggestions</TabsTrigger>
        </TabsList>
        <TabsContent value="rules" className="grid gap-4">
          <ul className="grid gap-3">{rulesView(review.results).map(card)}</ul>
          {review.gaps.length > 0 && (
            <section aria-labelledby={`${id}-gaps`} className="grid gap-2">
              <h3 id={`${id}-gaps`} className="text-section font-semibold">
                Outside the playbook
              </h3>
              <ul className="grid gap-3">{gapsView(review.gaps).map(card)}</ul>
            </section>
          )}
        </TabsContent>
        <TabsContent value="suggestions" className="grid gap-4">
          {suggestionsView(review.results, review.gaps).map((group) => (
            <section key={group.key} aria-labelledby={`${id}-${group.key}`} className="grid gap-2">
              <h3 id={`${id}-${group.key}`} className="text-section font-semibold">
                {group.title}
              </h3>
              <ul className="grid gap-3">{group.items.map(card)}</ul>
            </section>
          ))}
          {suggestionsView(review.results, review.gaps).length === 0 && (
            <p className="text-fg-muted">No edits were suggested.</p>
          )}
        </TabsContent>
      </Tabs>
    </section>
  );
}

export function ReviewRailSkeleton() {
  return (
    <div aria-busy="true" className="grid gap-3">
      <span className="sr-only">Loading results…</span>
      <Skeleton className="h-5 w-3/4" />
      <Skeleton className="h-7 w-56" />
      <Skeleton className="h-9" />
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="h-36" />
      ))}
    </div>
  );
}
