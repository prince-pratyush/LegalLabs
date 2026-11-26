export type CommandCenterTab = "overview" | "analytics" | "outcomes";

const TABS: readonly CommandCenterTab[] = ["overview", "analytics", "outcomes"];

/** `#/admin/command-center/overview` and its sibling tabs; anything else isn't this screen. */
export function parseCommandCenterRoute(hash: string): { tab: CommandCenterTab } | null {
  const [admin, page, tab = "overview"] = hash.replace(/^#\/?/, "").split("?")[0]?.split("/") ?? [];
  if (admin !== "admin" || page !== "command-center") return null;
  return TABS.includes(tab as CommandCenterTab) ? { tab: tab as CommandCenterTab } : null;
}

export const commandCenterHash = (tab: CommandCenterTab = "overview") =>
  `#/admin/command-center/${tab}`;
