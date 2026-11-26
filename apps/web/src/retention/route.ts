export type RetentionTab = "policies" | "holds" | "bin";

const TABS: readonly RetentionTab[] = ["policies", "holds", "bin"];

/** `#/admin/retention` and its tabs; anything else isn't this screen. */
export function parseRetentionRoute(hash: string): { tab: RetentionTab } | null {
  const [admin, page, tab = "policies"] = hash.replace(/^#\/?/, "").split("?")[0]?.split("/") ?? [];
  if (admin !== "admin" || page !== "retention") return null;
  return TABS.includes(tab as RetentionTab) ? { tab: tab as RetentionTab } : null;
}

export const retentionHash = (tab: RetentionTab = "policies") => `#/admin/retention/${tab}`;
