import type { Review, Suggestion } from "@legallabs/contracts";
import {
  type Alternate,
  type ApplyChoice,
  applyEvent,
  firstParagraph,
  gapItem,
  type ProgressState,
  type RailView,
  ReviewDocument,
  ReviewDocumentSkeleton,
  type ReviewItem,
  ReviewProgress,
  ReviewRail,
  ReviewRailSkeleton,
  ruleItem,
  startProgress,
  toast,
} from "@legallabs/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import { playbookApi } from "../playbooks/api.js";
import { messageOf } from "../vaults/shared.js";
import { followRun, type ReviewBody, reviewApi } from "./api.js";

const RUNNING = new Set(["planned", "running", "verifying"]);
type Download = "redline" | "docx" | "xlsx";

/** A review: progress while it runs, then the contract beside its cards. */
export function ReviewPage({ reviewId }: { reviewId: string }) {
  const [review, setReview] = useState<Review | null>(null);
  const [body, setBody] = useState<ReviewBody | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rules, setRules] = useState<{ id: string; title: string }[] | null>(null);
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [following, setFollowing] = useState<string | null>(null);
  // A re-run follows one rule, not the whole list.
  const [only, setOnly] = useState<string | null>(null);
  const [started, setStarted] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const [cancelling, setCancelling] = useState(false);
  const [view, setView] = useState<RailView>("rules");
  const [why, setWhy] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focus, setFocus] = useState<{ paragraph: number } | null>(null);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [alternates, setAlternates] = useState<Record<string, Alternate[] | null>>({});
  const [downloading, setDownloading] = useState<Download | null>(null);

  const reload = useCallback(
    () =>
      reviewApi.get(reviewId).then(
        (r) => {
          setReview(r);
          return r;
        },
        (err) => {
          setError(messageOf(err));
          return null;
        },
      ),
    [reviewId],
  );

  useEffect(() => {
    reload().then((r) => {
      if (r && RUNNING.has(r.status)) setFollowing(r.run_id);
    });
  }, [reload]);

  // The rule list for progress comes from the version the review ran against.
  useEffect(() => {
    if (!review || rules) return;
    const scope = review.customisation.scope;
    const named = review.results.map((f) => ({ id: f.rule_id, title: f.rule_title }));
    playbookApi.get(review.playbook_id).then(
      (p) =>
        setRules(
          p.rules
            .filter((r) => scope === "all" || scope.includes(r.id))
            .map((r) => ({ id: r.id, title: r.title })),
        ),
      () => setRules(named),
    );
  }, [review, rules]);

  const tracked = useMemo(
    () => (rules && only ? rules.filter((r) => r.id === only) : rules),
    [rules, only],
  );

  useEffect(() => {
    if (!following || !tracked) return;
    setStarted(Date.now());
    setProgress(startProgress(tracked.map((r) => r.id)));
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const stop = followRun(
      following,
      reviewId,
      (event) => setProgress((p) => (p ? applyEvent(p, event) : p)),
      () => {
        setFollowing(null);
        setOnly(null);
        setCancelling(false);
        reload();
      },
    );
    return () => {
      clearInterval(tick);
      stop();
    };
  }, [following, tracked, reviewId, reload]);

  const running = review !== null && (RUNNING.has(review.status) || following !== null);
  useEffect(() => {
    if (!review || running || body) return;
    reviewApi.body(reviewId).then(setBody, (err) => setError(messageOf(err)));
  }, [review, running, body, reviewId]);

  // Bring the chosen card into view when it was picked from the contract.
  useEffect(() => {
    if (!selectedId) return;
    document
      .querySelector('[aria-label="Review results"] article[data-selected]')
      ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selectedId]);

  const items = useMemo<ReviewItem[]>(
    () => (review ? [...review.results.map(ruleItem), ...review.gaps.map(gapItem)] : []),
    [review],
  );

  const decide = async (s: Suggestion, work: () => Promise<unknown>, done?: string) => {
    setBusy((ids) => new Set(ids).add(s.id));
    try {
      await work();
      await reload();
      if (done) toast.success(done);
    } catch (err) {
      toast.error(messageOf(err));
    } finally {
      setBusy((ids) => {
        const next = new Set(ids);
        next.delete(s.id);
        return next;
      });
    }
  };

  const save = async (kind: Download, work: () => Promise<void>) => {
    setDownloading(kind);
    try {
      await work();
    } catch (err) {
      toast.error(messageOf(err));
    } finally {
      setDownloading(null);
    }
  };

  if (!review) {
    return error ? (
      <p role="alert" className="text-destructive">
        {error}
      </p>
    ) : (
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_420px]">
        <ReviewDocumentSkeleton />
        <ReviewRailSkeleton />
      </div>
    );
  }

  const header = (
    <header className="grid gap-1">
      <h1 className="text-title font-semibold">{review.document_name}</h1>
      <p className="text-fg-muted">
        Reviewed against {review.playbook_name} for{" "}
        {review.customisation.party || "an unnamed party"}, on{" "}
        {review.customisation.paper === "ours" ? "our" : "their"} paper
      </p>
    </header>
  );

  if (running) {
    return (
      <div className="grid max-w-xl gap-4">
        {header}
        {tracked && progress ? (
          <ReviewProgress
            rules={tracked}
            state={progress}
            elapsedMs={now - started}
            cancelling={cancelling}
            onCancel={async () => {
              setCancelling(true);
              try {
                await reviewApi.cancel(reviewId);
              } catch (err) {
                setCancelling(false);
                toast.error(messageOf(err));
              }
            }}
          />
        ) : (
          <ReviewRailSkeleton />
        )}
      </div>
    );
  }

  const select = (item: ReviewItem) => {
    setSelectedId(item.id);
    const at = firstParagraph(item);
    if (Number.isFinite(at)) setFocus({ paragraph: at });
  };

  return (
    <div className="grid min-h-0 gap-4">
      {header}
      {review.status === "failed" && (
        <p role="alert" className="text-destructive">
          The review stopped before it finished. The results below are what it completed.
        </p>
      )}
      {review.status === "cancelled" && (
        <p role="status" className="text-fg-muted">
          The review was cancelled. The results below are what it completed.
        </p>
      )}
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_420px]">
        {body ? (
          <ReviewDocument
            paragraphs={body.paragraphs}
            items={items}
            selectedId={selectedId}
            onSelect={(id) => setSelectedId(id)}
            focus={focus}
            showJustifications={why}
          />
        ) : error ? (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        ) : (
          <ReviewDocumentSkeleton />
        )}
        <div className="lg:sticky lg:top-0 lg:max-h-[calc(100vh-6rem)] lg:overflow-auto">
          <ReviewRail
            review={review}
            kind={body?.kind ?? "docx"}
            view={view}
            onViewChange={setView}
            showJustifications={why}
            onShowJustifications={setWhy}
            selectedId={selectedId}
            onSelect={select}
            busyIds={busy}
            alternates={alternates}
            downloading={downloading}
            onGoTo={(paragraph) => setFocus({ paragraph })}
            onApply={(s: Suggestion, choice: ApplyChoice) =>
              decide(
                s,
                async () => {
                  const result = await reviewApi.apply(
                    reviewId,
                    s.id,
                    choice.withComment,
                    choice.alternateId,
                  );
                  if (result.status === "anchor_failed") {
                    throw new Error("The clause changed since the review. Re-run the rule.");
                  }
                },
                "Applied",
              )
            }
            onDismiss={(s) => decide(s, () => reviewApi.dismiss(reviewId, s.id))}
            onRevise={(s, instruction) =>
              decide(s, () => reviewApi.revise(reviewId, s.id, instruction), "Revised")
            }
            onAlternates={async (s) => {
              setAlternates((all) => ({ ...all, [s.id]: null }));
              try {
                const found = await reviewApi.alternates(reviewId, s.id);
                setAlternates((all) => ({ ...all, [s.id]: found }));
              } catch (err) {
                setAlternates((all) => {
                  const { [s.id]: _drop, ...rest } = all;
                  return rest;
                });
                toast.error(messageOf(err));
              }
            }}
            onRerun={async (ruleId) => {
              try {
                const { run_id } = await reviewApi.rerun(
                  reviewId,
                  ruleId,
                  review.document_version_id,
                );
                setOnly(ruleId);
                setFollowing(run_id);
              } catch (err) {
                toast.error(messageOf(err));
              }
            }}
            onApplyAll={async (withComment) => {
              try {
                const result = await reviewApi.applyAll(reviewId, withComment);
                await reload();
                toast.success(
                  result.failed.length > 0
                    ? `Applied ${result.applied.length}; ${result.failed.length} could not be placed`
                    : `Applied ${result.applied.length}`,
                );
              } catch (err) {
                toast.error(messageOf(err));
              }
            }}
            onDownloadRedline={(pending) =>
              save("redline", () => reviewApi.redline(reviewId, pending))
            }
            onExport={(format) => save(format, () => reviewApi.exportSummary(reviewId, format))}
          />
        </div>
      </div>
    </div>
  );
}
