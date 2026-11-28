export type HorizonRoute =
  | { page: "list" }
  | { page: "new" }
  | { page: "scan"; scanId: string }
  | { page: "edit"; scanId: string };

/** Hash routes under #/horizon, like the other pages. Notifications link here. */
export function parseHorizonRoute(hash: string): HorizonRoute | null {
  const [path = ""] = hash.replace(/^#\/?/, "").split("?");
  let parts: string[];
  try {
    parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return null;
  }
  const [app, scanId, page] = parts;
  if (app !== "horizon") return null;
  if (!scanId) return { page: "list" };
  if (scanId === "new") return { page: "new" };
  return page === "edit" ? { page: "edit", scanId } : { page: "scan", scanId };
}

export function horizonHash(route: HorizonRoute): string {
  switch (route.page) {
    case "list":
      return "#/horizon";
    case "new":
      return "#/horizon/new";
    case "scan":
      return `#/horizon/${encodeURIComponent(route.scanId)}`;
    case "edit":
      return `#/horizon/${encodeURIComponent(route.scanId)}/edit`;
  }
}

export const goHorizon = (route: HorizonRoute) => {
  window.location.hash = horizonHash(route);
};
