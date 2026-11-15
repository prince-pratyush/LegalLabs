export type ReviewRoute =
  | { page: "new"; playbookId: string | null; documentId: string | null }
  | { page: "review"; reviewId: string };

/** Hash routes, like the playbook pages: #/reviews/new?playbook=…&document=…, #/reviews/{id}. */
export function parseReviewRoute(hash: string): ReviewRoute | null {
  const [path = "", query = ""] = hash.replace(/^#\/?/, "").split("?");
  const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] !== "reviews" || !parts[1]) return null;
  if (parts[1] === "new") {
    const params = new URLSearchParams(query);
    return {
      page: "new",
      playbookId: params.get("playbook") || null,
      documentId: params.get("document") || null,
    };
  }
  return { page: "review", reviewId: parts[1] };
}

export function reviewHash(route: ReviewRoute): string {
  if (route.page === "review") return `#/reviews/${encodeURIComponent(route.reviewId)}`;
  const params = new URLSearchParams();
  if (route.playbookId) params.set("playbook", route.playbookId);
  if (route.documentId) params.set("document", route.documentId);
  const query = params.toString();
  return `#/reviews/new${query ? `?${query}` : ""}`;
}

export const goReviews = (route: ReviewRoute) => {
  window.location.hash = reviewHash(route);
};
