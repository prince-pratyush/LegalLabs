import { AppShell, Button } from "@legallabs/ui";
import { goPlaybooks } from "../playbooks/route.js";
import { useHash } from "../vaults/route.js";
import { NewReview } from "./NewReview.js";
import { ReviewPage } from "./ReviewPage.js";
import { goReviews, parseReviewRoute } from "./route.js";

/** Starting a playbook review and working through its results. */
export function ReviewsApp({ onLeave }: { onLeave: () => void }) {
  const route = parseReviewRoute(useHash());
  if (!route) return null;
  return (
    <AppShell
      brand="LegalLabs"
      sidebarLabel="Reviews"
      commands={[
        {
          id: "review-new",
          kind: "action",
          group: "Reviews",
          label: "Review a contract",
          run: () => goReviews({ page: "new", playbookId: null, documentId: null }),
        },
        {
          id: "playbooks",
          kind: "action",
          group: "Go to",
          label: "Playbooks",
          run: () => goPlaybooks({ page: "list" }),
        },
        { id: "threads", kind: "action", group: "Go to", label: "Threads", run: onLeave },
      ]}
      sidebar={
        <div className="grid min-w-0 gap-2">
          <Button variant="quiet" size="sm" className="justify-start" onClick={onLeave}>
            Back to threads
          </Button>
          <Button
            variant="quiet"
            size="sm"
            className="justify-start"
            onClick={() => goPlaybooks({ page: "list" })}
          >
            Playbooks
          </Button>
          <Button
            variant="quiet"
            size="sm"
            className="justify-start aria-[current=page]:tint-selected"
            aria-current={route.page === "new" ? "page" : undefined}
            onClick={() => goReviews({ page: "new", playbookId: null, documentId: null })}
          >
            Review a contract
          </Button>
        </div>
      }
    >
      <main id="main" className="flex min-w-0 flex-1 flex-col overflow-auto p-6">
        {route.page === "new" ? (
          <NewReview
            key={`${route.playbookId}-${route.documentId}`}
            playbookId={route.playbookId}
            documentId={route.documentId}
            onCancel={() => window.history.back()}
          />
        ) : (
          <ReviewPage key={route.reviewId} reviewId={route.reviewId} />
        )}
      </main>
    </AppShell>
  );
}
