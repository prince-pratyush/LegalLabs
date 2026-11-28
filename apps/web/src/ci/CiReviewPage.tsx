import { CiResult, type CiReview } from "@legallabs/contracts";
import { Button, EmptyState, Skeleton } from "@legallabs/ui";
import { useCallback, useEffect, useState } from "react";
import { ApiError, api, messageOf } from "../api.js";
import { ReviewPage } from "../reviews/ReviewPage.js";
import { ciApi } from "./api.js";
import { PrincipalPicker } from "./PrincipalPicker.js";
import { goCi } from "./route.js";
import { ReviewStatusText } from "./shared.js";

const POLL_MS = 3000;

const FAILURES: Record<string, string> = {
  FORBIDDEN: "The agent's owner can no longer run this review.",
  ACCESS_LOST: "Access to the contract or the playbook was lost.",
  REVIEW_FAILED: "The review stopped before it finished.",
  REVIEW_CANCELLED: "The review was cancelled.",
  TIMED_OUT: "The review took too long and was given up on.",
  MODEL_NOT_ALLOWED: "The contract's matter allows no model for this review.",
};

const WAITING: Partial<Record<CiReview["status"], string>> = {
  queued: "Waiting for its turn to be reviewed.",
  running: "The review is starting.",
};

/** One contract in the queue: its outcome and what to do with it, then the playbook review. */
export function CiReviewPage({ reviewId }: { reviewId: string }) {
  const [review, setReview] = useState<CiReview | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [me, setMe] = useState<string | null>(null);
  const [owned, setOwned] = useState(false);
  const [reassigning, setReassigning] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    () =>
      ciApi.review(reviewId).then(setReview, (err) => {
        if (err instanceof ApiError && err.status === 404) setMissing(true);
        else setError(messageOf(err));
      }),
    [reviewId],
  );
  useEffect(() => {
    load();
    api.session().then(
      (s) => setMe(s.user_id),
      () => undefined,
    );
  }, [load]);

  // An agent is only listed for its owner, so listing it says the review is theirs.
  const agentId = review?.agent_id;
  useEffect(() => {
    if (!agentId) return;
    ciApi.agents().then(
      (agents) => setOwned(agents.some((a) => a.id === agentId)),
      () => undefined,
    );
  }, [agentId]);

  const waiting = review?.status === "queued" || review?.status === "running";
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [waiting, load]);

  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  if (missing) {
    return (
      <EmptyState
        title="Review not found"
        description="It may have been removed, or you may not have access to it."
        action={{ label: "Back to the queue", onClick: () => goCi({ page: "queue" }) }}
      />
    );
  }
  if (!review) {
    return error ? (
      <p role="alert" className="text-destructive">
        {error}
      </p>
    ) : (
      <div aria-busy="true" className="grid max-w-xl gap-2">
        <Skeleton className="h-6" />
        <Skeleton className="h-16" />
      </div>
    );
  }

  const done = review.status === "done";
  const canAct = !done && (owned || (me !== null && review.assignee_id === me));
  const finished = (CiResult.options as readonly string[]).includes(review.status);

  return (
    <div className="grid content-start gap-4">
      <h1 className="text-title font-semibold">{review.document_name}</h1>
      <section aria-label="Outcome" className="grid gap-2 rounded-md border border-border p-3">
        <div className="flex flex-wrap items-center gap-3">
          <ReviewStatusText status={review.status} />
          <span className="text-fg-muted">
            {review.agent_name}
            {review.counterparty ? ` · ${review.counterparty}` : ""}
            {review.assignee_name ? ` · Assigned to ${review.assignee_name}` : ""}
          </span>
          <span className="ml-auto flex gap-2">
            {canAct && (
              <Button
                variant="secondary"
                size="sm"
                aria-expanded={reassigning}
                onClick={() => setReassigning((open) => !open)}
              >
                Reassign
              </Button>
            )}
            {owned && !waiting && (
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() =>
                  act(async () => {
                    await ciApi.rerun(review.id);
                    await load();
                  })
                }
              >
                Run again
              </Button>
            )}
            {canAct && finished && (
              <Button
                size="sm"
                disabled={busy}
                onClick={() => act(async () => setReview(await ciApi.markDone(review.id)))}
              >
                Mark done
              </Button>
            )}
          </span>
        </div>
        {review.summary && <p>{review.summary}</p>}
        {review.status === "failed" && (
          <p className="text-destructive">
            {FAILURES[review.failure ?? ""] ?? `The review could not run (${review.failure}).`}
          </p>
        )}
        {reassigning && canAct && (
          <div className="max-w-sm">
            <PrincipalPicker
              kinds="user"
              onPick={(person) =>
                act(async () => {
                  setReview(await ciApi.assign(review.id, person.id));
                  setReassigning(false);
                })
              }
            />
          </div>
        )}
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
      </section>
      {review.playbook_review_id ? (
        <ReviewPage
          key={review.playbook_review_id}
          reviewId={review.playbook_review_id}
          titled={false}
        />
      ) : (
        WAITING[review.status] && (
          <p role="status" className="text-fg-muted">
            {WAITING[review.status]}
          </p>
        )
      )}
    </div>
  );
}
