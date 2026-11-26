export type SpaceTab = "tasks" | "members" | "resources" | "guests" | "activity" | "context";

const TABS: readonly SpaceTab[] = [
  "tasks",
  "members",
  "resources",
  "guests",
  "activity",
  "context",
];

export type SpaceRoute = { page: "list" } | { page: "space"; spaceId: string; tab: SpaceTab };

/** `#/spaces` and `#/spaces/<id>/<tab>`; anything else isn't a Spaces screen. */
export function parseSpaceRoute(hash: string): SpaceRoute | null {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] !== "spaces") return null;
  const spaceId = parts[1];
  if (!spaceId) return { page: "list" };
  const tab = TABS.find((t) => t === parts[2]) ?? "tasks";
  return { page: "space", spaceId, tab };
}

export const spacesHash = (spaceId?: string, tab: SpaceTab = "tasks") =>
  spaceId ? `#/spaces/${encodeURIComponent(spaceId)}/${tab}` : "#/spaces";
