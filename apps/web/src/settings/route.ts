export type SettingsTab = "notifications" | "memory" | "writing-styles";

const TABS: readonly SettingsTab[] = ["notifications", "memory", "writing-styles"];

/** `#/settings` and `#/settings/<tab>`; anything else isn't Settings. */
export function parseSettingsRoute(hash: string): { tab: SettingsTab } | null {
  const [page, tab] = hash.replace(/^#\/?/, "").split("?")[0]?.split("/") ?? [];
  if (page !== "settings") return null;
  return { tab: TABS.includes(tab as SettingsTab) ? (tab as SettingsTab) : "notifications" };
}

export const settingsHash = (tab: SettingsTab = "notifications") => `#/settings/${tab}`;
