export type AdminModelsTab = "models" | "connectors";

const TABS: readonly AdminModelsTab[] = ["models", "connectors"];

/** `#/admin/models` and `#/admin/connectors`; anything else isn't this screen. */
export function parseAdminModelsRoute(hash: string): { tab: AdminModelsTab } | null {
  const [page, tab] = hash.replace(/^#\/?/, "").split("?")[0]?.split("/") ?? [];
  if (page !== "admin" || !TABS.includes(tab as AdminModelsTab)) return null;
  return { tab: tab as AdminModelsTab };
}

export const adminModelsHash = (tab: AdminModelsTab = "models") => `#/admin/${tab}`;
