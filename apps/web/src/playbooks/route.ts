export type PlaybookRoute =
  | { page: "list" }
  | { page: "playbook"; playbookId: string; version: number | null };

/** Hash routes, like the vaults pages, so the API's static server needs no rewrites. */
export function parsePlaybookRoute(hash: string): PlaybookRoute | null {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] !== "playbooks") return null;
  const playbookId = parts[1];
  if (!playbookId) return { page: "list" };
  const no = parts[2] === "versions" ? Number(parts[3]) : Number.NaN;
  return { page: "playbook", playbookId, version: Number.isInteger(no) && no > 0 ? no : null };
}

export function playbookHash(route: PlaybookRoute): string {
  if (route.page === "list") return "#/playbooks";
  const base = `#/playbooks/${encodeURIComponent(route.playbookId)}`;
  return route.version ? `${base}/versions/${route.version}` : base;
}

export const goPlaybooks = (route: PlaybookRoute) => {
  window.location.hash = playbookHash(route);
};
