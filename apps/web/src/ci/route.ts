export type CiRoute =
  | { page: "queue" }
  | { page: "agents" }
  | { page: "new-agent" }
  | { page: "agent"; agentId: string }
  | { page: "submit"; agentId: string | null }
  | { page: "review"; reviewId: string };

/** Hash routes under #/ci, like the other pages, so the API's static server needs no rewrites. */
export function parseCiRoute(hash: string): CiRoute | null {
  const [path = "", query = ""] = hash.replace(/^#\/?/, "").split("?");
  const [app, page, itemId] = path.split("/").filter(Boolean).map(decodeURIComponent);
  if (app !== "ci") return null;
  if (!page) return { page: "queue" };
  if (page === "reviews" && itemId) return { page: "review", reviewId: itemId };
  if (page === "submit") {
    return { page: "submit", agentId: new URLSearchParams(query).get("agent") };
  }
  if (page !== "agents") return null;
  if (!itemId) return { page: "agents" };
  return itemId === "new" ? { page: "new-agent" } : { page: "agent", agentId: itemId };
}

export function ciHash(route: CiRoute): string {
  const e = encodeURIComponent;
  switch (route.page) {
    case "queue":
      return "#/ci";
    case "agents":
      return "#/ci/agents";
    case "new-agent":
      return "#/ci/agents/new";
    case "agent":
      return `#/ci/agents/${e(route.agentId)}`;
    case "submit":
      return `#/ci/submit${route.agentId ? `?agent=${e(route.agentId)}` : ""}`;
    case "review":
      return `#/ci/reviews/${e(route.reviewId)}`;
  }
}

export const goCi = (route: CiRoute) => {
  window.location.hash = ciHash(route);
};
