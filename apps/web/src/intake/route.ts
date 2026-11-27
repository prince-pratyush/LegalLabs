export type IntakeRoute =
  | { page: "queue" }
  | { page: "request"; requestId: string }
  | { page: "types" }
  | { page: "new-type" }
  | { page: "type"; typeId: string };

/** Hash routes under #/intake, like the other pages, so the API's static server needs no rewrites. */
export function parseIntakeRoute(hash: string): IntakeRoute | null {
  const [path = ""] = hash.replace(/^#\/?/, "").split("?");
  let parts: string[];
  try {
    parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return null;
  }
  const [app, page, itemId] = parts;
  if (app !== "intake") return null;
  if (!page) return { page: "queue" };
  if (page === "requests" && itemId) return { page: "request", requestId: itemId };
  if (page !== "types") return null;
  if (!itemId) return { page: "types" };
  return itemId === "new" ? { page: "new-type" } : { page: "type", typeId: itemId };
}

export function intakeHash(route: IntakeRoute): string {
  const e = encodeURIComponent;
  switch (route.page) {
    case "queue":
      return "#/intake";
    case "request":
      return `#/intake/requests/${e(route.requestId)}`;
    case "types":
      return "#/intake/types";
    case "new-type":
      return "#/intake/types/new";
    case "type":
      return `#/intake/types/${e(route.typeId)}`;
  }
}

export const goIntake = (route: IntakeRoute) => {
  window.location.hash = intakeHash(route);
};
